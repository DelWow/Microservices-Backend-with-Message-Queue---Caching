import { OrderCreatedEventSchema, type OrderCreatedEvent } from '@microservices/contracts';
import type { Channel, Message } from 'amqplib';

import type { NotificationApplication } from './notification-application.js';
import type { RecordNotificationDeliveryResult } from './notification-repository.js';

export type InvalidOrderCreatedEventReason = 'invalid-json' | 'unsupported-envelope';

export class InvalidOrderCreatedEventError extends Error {
  public constructor(public readonly reason: InvalidOrderCreatedEventReason) {
    super(
      reason === 'invalid-json'
        ? 'RabbitMQ message body is not valid JSON'
        : 'RabbitMQ message does not match the supported order.created v1 contract',
    );
    this.name = 'InvalidOrderCreatedEventError';
  }
}

export function parseOrderCreatedEvent(content: Buffer): OrderCreatedEvent {
  let decoded: unknown;

  try {
    decoded = JSON.parse(content.toString('utf8')) as unknown;
  } catch {
    throw new InvalidOrderCreatedEventError('invalid-json');
  }

  const parsed = OrderCreatedEventSchema.safeParse(decoded);

  if (!parsed.success) {
    throw new InvalidOrderCreatedEventError('unsupported-envelope');
  }

  return parsed.data;
}

export interface NotificationMessageProcessorOptions {
  readonly application: NotificationApplication;
  readonly channel: Pick<Channel, 'ack'>;
}

export class NotificationMessageProcessor {
  readonly #application: NotificationApplication;
  readonly #channel: Pick<Channel, 'ack'>;

  public constructor(options: NotificationMessageProcessorOptions) {
    this.#application = options.application;
    this.#channel = options.channel;
  }

  public async process(message: Message): Promise<RecordNotificationDeliveryResult> {
    const event = parseOrderCreatedEvent(message.content);
    const result = await this.#application.handleOrderCreated(event);
    this.#channel.ack(message);
    return result;
  }
}
