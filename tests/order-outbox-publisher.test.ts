import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import {
  ORDER_CREATED_ROUTING_KEY,
  ORDER_EVENTS_EXCHANGE,
} from '../packages/platform/src/index.js';
import {
  OrderOutboxPublisher,
  RabbitMqPublishTimeoutError,
  type ClaimedOrderOutboxEvent,
  type OrderEventPublishChannel,
  type OrderOutboxRepository,
} from '../services/order-service/src/index.js';

const CLAIMED_EVENT: ClaimedOrderOutboxEvent = {
  event: {
    eventId: '066037b6-2f0d-4b67-b0f0-11763e346fec',
    eventType: 'order.created',
    eventVersion: 1,
    occurredAt: '2026-09-18T12:00:00.000Z',
    correlationId: 'request-1',
    traceContext: {
      baggage: 'tenant=customer-1',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      tracestate: 'vendor=value',
    },
    payload: { order: { id: 'order-1' } },
  },
  lockToken: 'lock-1',
  orderId: 'order-1',
  publishAttempts: 0,
};

interface RepositoryFixture {
  readonly claimNext: Mock<OrderOutboxRepository['claimNext']>;
  readonly markFailed: Mock<OrderOutboxRepository['markFailed']>;
  readonly markPublished: Mock<OrderOutboxRepository['markPublished']>;
  readonly repository: OrderOutboxRepository;
}

interface ChannelFixture {
  readonly channel: OrderEventPublishChannel;
  readonly emitter: EventEmitter;
  readonly publish: Mock<OrderEventPublishChannel['publish']>;
}

function createRepository(
  claimed: ClaimedOrderOutboxEvent | null = CLAIMED_EVENT,
): RepositoryFixture {
  const claimNext = vi.fn<OrderOutboxRepository['claimNext']>().mockResolvedValue(claimed);
  const markFailed = vi.fn<OrderOutboxRepository['markFailed']>().mockResolvedValue(undefined);
  const markPublished = vi
    .fn<OrderOutboxRepository['markPublished']>()
    .mockResolvedValue(undefined);
  return {
    claimNext,
    markFailed,
    markPublished,
    repository: { claimNext, markFailed, markPublished },
  };
}

function createChannel(implementation: OrderEventPublishChannel['publish']): ChannelFixture {
  const emitter = new EventEmitter();
  const publish = vi.fn<OrderEventPublishChannel['publish']>().mockImplementation(implementation);
  const channel = Object.assign(emitter, { publish }) as unknown as OrderEventPublishChannel;
  return { channel, emitter, publish };
}

function createPublisher(
  repository: OrderOutboxRepository,
  channel: OrderEventPublishChannel,
  options: { readonly confirmTimeoutMs?: number } = {},
): OrderOutboxPublisher {
  return new OrderOutboxPublisher(
    repository,
    {
      channel: () => channel,
      exchange: ORDER_EVENTS_EXCHANGE,
      routingKey: ORDER_CREATED_ROUTING_KEY,
      ...(options.confirmTimeoutMs === undefined
        ? {}
        : { confirmTimeoutMs: options.confirmTimeoutMs }),
    },
    {
      clock: () => new Date('2026-09-18T12:00:10.000Z'),
      lockTokenGenerator: () => 'lock-1',
    },
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('OrderOutboxPublisher', () => {
  it('does nothing when no outbox event is ready', async () => {
    const repository = createRepository(null);
    const channel = createChannel(() => true);

    await expect(
      createPublisher(repository.repository, channel.channel).publishNext(),
    ).resolves.toBe(false);
    expect(repository.claimNext).toHaveBeenCalledWith(
      new Date('2026-09-18T12:00:10.000Z'),
      'lock-1',
      30_000,
    );
    expect(channel.publish).not.toHaveBeenCalled();
  });

  it('publishes the exact event persistently with routing and tracing metadata', async () => {
    const repository = createRepository();
    const channel = createChannel((_exchange, _routingKey, _content, _options, callback) => {
      callback(null);
      return true;
    });

    await expect(
      createPublisher(repository.repository, channel.channel).publishNext(),
    ).resolves.toBe(true);

    expect(channel.publish).toHaveBeenCalledOnce();
    const [exchange, routingKey, content, options] = channel.publish.mock.calls[0] ?? [];
    expect(exchange).toBe(ORDER_EVENTS_EXCHANGE);
    expect(routingKey).toBe(ORDER_CREATED_ROUTING_KEY);
    expect(JSON.parse(content?.toString('utf8') ?? '')).toEqual(CLAIMED_EVENT.event);
    expect(options).toEqual({
      contentEncoding: 'utf-8',
      contentType: 'application/json',
      correlationId: 'request-1',
      headers: {
        baggage: 'tenant=customer-1',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        tracestate: 'vendor=value',
        'x-correlation-id': 'request-1',
        'x-event-version': 1,
        'x-publish-attempt': 1,
      },
      mandatory: true,
      messageId: CLAIMED_EVENT.event.eventId,
      persistent: true,
      timestamp: 1_789_732_800,
      type: 'order.created',
    });
    expect(repository.markPublished).toHaveBeenCalledWith(
      CLAIMED_EVENT,
      new Date('2026-09-18T12:00:10.000Z'),
    );
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it('records a negative publisher acknowledgement for retry', async () => {
    const repository = createRepository();
    const negativeAcknowledgement = new Error('message nacked');
    const channel = createChannel((_exchange, _routingKey, _content, _options, callback) => {
      callback(negativeAcknowledgement);
      return true;
    });

    await expect(
      createPublisher(repository.repository, channel.channel).publishNext(),
    ).rejects.toBe(negativeAcknowledgement);
    expect(repository.markFailed).toHaveBeenCalledWith(
      CLAIMED_EVENT,
      new Date('2026-09-18T12:00:11.000Z'),
      'message nacked',
    );
    expect(repository.markPublished).not.toHaveBeenCalled();
  });

  it('records a synchronous channel publish failure for retry', async () => {
    const repository = createRepository();
    const channelFailure = new Error('channel closed');
    const channel = createChannel(() => {
      throw channelFailure;
    });

    await expect(
      createPublisher(repository.repository, channel.channel).publishNext(),
    ).rejects.toBe(channelFailure);
    expect(repository.markFailed).toHaveBeenCalledWith(
      CLAIMED_EVENT,
      new Date('2026-09-18T12:00:11.000Z'),
      'channel closed',
    );
  });

  it('times out an unconfirmed publish and releases it for retry', async () => {
    vi.useFakeTimers();
    const repository = createRepository();
    const channel = createChannel(() => true);
    const result = createPublisher(repository.repository, channel.channel, {
      confirmTimeoutMs: 25,
    }).publishNext();
    const rejection = expect(result).rejects.toBeInstanceOf(RabbitMqPublishTimeoutError);

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(repository.markFailed).toHaveBeenCalledWith(
      CLAIMED_EVENT,
      new Date('2026-09-18T12:00:11.000Z'),
      'RabbitMQ publisher confirmation timed out after 25ms',
    );
  });

  it('waits for channel backpressure to drain after confirmation', async () => {
    const repository = createRepository();
    const channel = createChannel((_exchange, _routingKey, _content, _options, callback) => {
      callback(null);
      return false;
    });
    const result = createPublisher(repository.repository, channel.channel).publishNext();

    await Promise.resolve();
    expect(repository.markPublished).not.toHaveBeenCalled();
    channel.emitter.emit('drain');
    await expect(result).resolves.toBe(true);
    expect(repository.markPublished).toHaveBeenCalledOnce();
  });
});
