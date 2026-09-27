import type { Message } from 'amqplib';
import { describe, expect, it, type Mock, vi } from 'vitest';

import type { OrderCreatedEvent } from '../packages/contracts/src/index.js';
import {
  createNotificationApplication,
  InvalidOrderCreatedEventError,
  NotificationMessageProcessor,
  parseOrderCreatedEvent,
  type NotificationApplicationLogger,
  type NotificationDeliveryRepository,
} from '../services/notification-service/src/index.js';

const EVENT: OrderCreatedEvent = {
  eventId: '520470e6-0c85-4bf4-8cd2-73c217b02e48',
  eventType: 'order.created',
  eventVersion: 1,
  occurredAt: '2026-09-23T15:00:00.000Z',
  correlationId: 'request-1',
  traceContext: {
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  },
  payload: {
    order: {
      id: '8e1dfcec-8e3d-4bb1-8a73-ec85c2f7e6da',
      customerId: 'customer-1',
      status: 'pending',
      currency: 'CAD',
      items: [{ productId: 'product-1', quantity: 2, unitPriceCents: 1_250 }],
      totalCents: 2_500,
      createdAt: '2026-09-23T15:00:00.000Z',
      updatedAt: '2026-09-23T15:00:00.000Z',
    },
  },
};

interface RepositoryFixture {
  readonly recordDelivery: Mock<NotificationDeliveryRepository['recordDelivery']>;
  readonly repository: NotificationDeliveryRepository;
}

function createRepository(result: 'recorded' | 'duplicate' = 'recorded'): RepositoryFixture {
  const recordDelivery = vi
    .fn<NotificationDeliveryRepository['recordDelivery']>()
    .mockResolvedValue(result);
  return { recordDelivery, repository: { recordDelivery } };
}

function createLogger(): {
  readonly info: Mock<NotificationApplicationLogger['info']>;
  readonly logger: NotificationApplicationLogger;
} {
  const info = vi.fn<NotificationApplicationLogger['info']>();
  return { info, logger: { info } };
}

function createMessage(value: unknown): Message {
  return {
    content: Buffer.from(JSON.stringify(value), 'utf8'),
    fields: {
      consumerTag: 'notification-consumer',
      deliveryTag: 1,
      redelivered: false,
      exchange: 'orders.events.v1',
      routingKey: 'order.created.v1',
    },
    properties: {
      contentType: 'application/json',
      contentEncoding: 'utf-8',
      headers: {},
      deliveryMode: 2,
      priority: undefined,
      correlationId: EVENT.correlationId,
      replyTo: undefined,
      expiration: undefined,
      messageId: EVENT.eventId,
      timestamp: undefined,
      type: EVENT.eventType,
      userId: undefined,
      appId: undefined,
      clusterId: undefined,
    },
  };
}

describe('Notification Service application', () => {
  it('creates a persisted log notification from an order event', async () => {
    const repository = createRepository();
    const { info, logger } = createLogger();
    const application = createNotificationApplication({
      clock: () => new Date('2026-09-23T15:00:01.000Z'),
      logger,
      notificationIdGenerator: () => '0cfbb6c6-f0b7-4b79-8494-1f2f70f4e654',
      repository: repository.repository,
    });

    await expect(application.handleOrderCreated(EVENT)).resolves.toBe('recorded');
    expect(repository.recordDelivery).toHaveBeenCalledWith({
      notificationId: '0cfbb6c6-f0b7-4b79-8494-1f2f70f4e654',
      eventId: EVENT.eventId,
      eventType: 'order.created',
      eventVersion: 1,
      orderId: EVENT.payload.order.id,
      customerId: 'customer-1',
      channel: 'log',
      status: 'sent',
      message: `Order ${EVENT.payload.order.id} was created`,
      processedAt: new Date('2026-09-23T15:00:01.000Z'),
    });
    expect(info).toHaveBeenCalledWith(
      {
        deliveryStatus: 'recorded',
        eventId: EVENT.eventId,
        eventType: 'order.created',
        notificationChannel: 'log',
        notificationId: '0cfbb6c6-f0b7-4b79-8494-1f2f70f4e654',
        orderId: EVENT.payload.order.id,
      },
      'Order notification delivered',
    );
  });

  it('reports a duplicate without repeating notification work', async () => {
    const repository = createRepository('duplicate');
    const { info, logger } = createLogger();
    const application = createNotificationApplication({
      logger,
      repository: repository.repository,
    });

    await expect(application.handleOrderCreated(EVENT)).resolves.toBe('duplicate');
    expect(repository.recordDelivery).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      {
        deliveryStatus: 'duplicate',
        eventId: EVENT.eventId,
        eventType: 'order.created',
        orderId: EVENT.payload.order.id,
      },
      'Duplicate order event already processed',
    );
  });
});

describe('order.created message validation and acknowledgement', () => {
  it('parses the supported strict event contract', () => {
    expect(parseOrderCreatedEvent(createMessage(EVENT).content)).toEqual(EVENT);
  });

  it('classifies invalid JSON and unsupported event versions', () => {
    expect(() => parseOrderCreatedEvent(Buffer.from('{invalid', 'utf8'))).toThrow(
      expect.objectContaining({ reason: 'invalid-json' }),
    );
    expect(() =>
      parseOrderCreatedEvent(createMessage({ ...EVENT, eventVersion: 2 }).content),
    ).toThrow(expect.objectContaining({ reason: 'unsupported-envelope' }));
  });

  it('acknowledges recorded and duplicate events only after application handling', async () => {
    const handleOrderCreated = vi
      .fn()
      .mockResolvedValueOnce('recorded')
      .mockResolvedValueOnce('duplicate');
    const ack = vi.fn();
    const processor = new NotificationMessageProcessor({
      application: { handleOrderCreated },
      channel: { ack },
    });
    const message = createMessage(EVENT);

    await expect(processor.process(message)).resolves.toBe('recorded');
    await expect(processor.process(message)).resolves.toBe('duplicate');
    expect(handleOrderCreated).toHaveBeenCalledTimes(2);
    expect(ack).toHaveBeenCalledTimes(2);
    expect(ack).toHaveBeenNthCalledWith(1, message);
  });

  it('does not acknowledge validation or repository failures', async () => {
    const persistenceFailure = new Error('MongoDB unavailable');
    const handleOrderCreated = vi.fn().mockRejectedValue(persistenceFailure);
    const ack = vi.fn();
    const processor = new NotificationMessageProcessor({
      application: { handleOrderCreated },
      channel: { ack },
    });

    await expect(
      processor.process(createMessage({ ...EVENT, eventVersion: 2 })),
    ).rejects.toBeInstanceOf(InvalidOrderCreatedEventError);
    await expect(processor.process(createMessage(EVENT))).rejects.toBe(persistenceFailure);
    expect(ack).not.toHaveBeenCalled();
  });
});
