import { randomUUID } from 'node:crypto';

import type { ClaimedOrderOutboxEvent, OrderOutboxRepository } from './order-outbox-repository.js';

const DEFAULT_CONFIRM_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const MAX_ERROR_MESSAGE_LENGTH = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

export interface OrderEventPublishOptions {
  readonly contentEncoding: 'utf-8';
  readonly contentType: 'application/json';
  readonly correlationId: string;
  readonly headers: Readonly<Record<string, string | number>>;
  readonly mandatory: true;
  readonly messageId: string;
  readonly persistent: true;
  readonly timestamp: number;
  readonly type: 'order.created';
}

export interface OrderEventPublishChannel {
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: OrderEventPublishOptions,
    callback: (error: Error | null) => void,
  ): boolean;
  once(event: 'drain', listener: () => void): this;
  removeListener(event: 'drain', listener: () => void): this;
}

export interface OrderOutboxPublisherOptions {
  readonly channel: () => OrderEventPublishChannel;
  readonly confirmTimeoutMs?: number;
  readonly exchange: string;
  readonly lockTimeoutMs?: number;
  readonly routingKey: string;
}

export interface OrderOutboxPublisherDependencies {
  readonly clock?: () => Date;
  readonly lockTokenGenerator?: () => string;
}

export class RabbitMqPublishTimeoutError extends Error {
  public constructor(timeoutMs: number) {
    super(`RabbitMQ publisher confirmation timed out after ${String(timeoutMs)}ms`);
    this.name = 'RabbitMqPublishTimeoutError';
  }
}

function retryDelayMs(completedAttempts: number): number {
  return Math.min(1_000 * 2 ** completedAttempts, MAX_RETRY_DELAY_MS);
}

function errorMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function messageHeaders(
  claimed: ClaimedOrderOutboxEvent,
): Readonly<Record<string, string | number>> {
  const { traceContext } = claimed.event;
  return {
    'x-event-version': claimed.event.eventVersion,
    'x-publish-attempt': claimed.publishAttempts + 1,
    'x-correlation-id': claimed.event.correlationId,
    ...(traceContext.traceparent === undefined ? {} : { traceparent: traceContext.traceparent }),
    ...(traceContext.tracestate === undefined ? {} : { tracestate: traceContext.tracestate }),
    ...(traceContext.baggage === undefined ? {} : { baggage: traceContext.baggage }),
  };
}

function publishConfirmed(
  channel: OrderEventPublishChannel,
  exchange: string,
  routingKey: string,
  claimed: ClaimedOrderOutboxEvent,
  timeoutMs: number,
): Promise<void> {
  const content = Buffer.from(JSON.stringify(claimed.event), 'utf8');

  return new Promise((resolve, reject) => {
    let confirmed = false;
    let drained = true;
    let publishReturned = false;
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timeout);
      channel.removeListener('drain', onDrain);
    };
    const succeedIfReady = (): void => {
      if (!settled && publishReturned && confirmed && drained) {
        settled = true;
        cleanup();
        resolve();
      }
    };
    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    };
    const onDrain = (): void => {
      drained = true;
      succeedIfReady();
    };
    const timeout = setTimeout(() => {
      fail(new RabbitMqPublishTimeoutError(timeoutMs));
    }, timeoutMs);
    let writable: boolean;

    try {
      writable = channel.publish(
        exchange,
        routingKey,
        content,
        {
          contentEncoding: 'utf-8',
          contentType: 'application/json',
          correlationId: claimed.event.correlationId,
          headers: messageHeaders(claimed),
          mandatory: true,
          messageId: claimed.event.eventId,
          persistent: true,
          timestamp: Math.floor(new Date(claimed.event.occurredAt).getTime() / 1_000),
          type: claimed.event.eventType,
        },
        (error) => {
          if (error !== null) {
            fail(error);
            return;
          }

          confirmed = true;
          succeedIfReady();
        },
      );
    } catch (error: unknown) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    if (!writable) {
      drained = false;
      channel.once('drain', onDrain);
    }

    publishReturned = true;
    succeedIfReady();
  });
}

export class OrderOutboxPublisher {
  readonly #clock: () => Date;
  readonly #lockTokenGenerator: () => string;

  public constructor(
    private readonly repository: OrderOutboxRepository,
    private readonly options: OrderOutboxPublisherOptions,
    dependencies: OrderOutboxPublisherDependencies = {},
  ) {
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#lockTokenGenerator = dependencies.lockTokenGenerator ?? randomUUID;
  }

  public async publishNext(): Promise<boolean> {
    const claimed = await this.repository.claimNext(
      this.#clock(),
      this.#lockTokenGenerator(),
      this.options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    );

    if (claimed === null) {
      return false;
    }

    try {
      await publishConfirmed(
        this.options.channel(),
        this.options.exchange,
        this.options.routingKey,
        claimed,
        this.options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS,
      );
      await this.repository.markPublished(claimed, this.#clock());
      return true;
    } catch (error: unknown) {
      const now = this.#clock();
      await this.repository.markFailed(
        claimed,
        new Date(now.getTime() + retryDelayMs(claimed.publishAttempts)),
        errorMessage(error),
      );
      throw error;
    }
  }
}
