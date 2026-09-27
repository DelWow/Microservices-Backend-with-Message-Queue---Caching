import { resolve } from 'node:path';

import { connect as connectAmqp, type Channel, type GetMessage } from 'amqplib';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { describe, expect, it } from 'vitest';

import {
  applyBootstrap,
  assertRabbitMqTopology,
  closeMongo,
  connectMongo,
  createMongoClient,
  NOTIFICATION_QUEUE,
  ORDER_CREATED_ROUTING_KEY,
  ORDER_EVENTS_EXCHANGE,
} from '../packages/platform/src/index.js';
import {
  MongoOrderOutboxRepository,
  MongoOrderRepository,
  OrderManagementService,
  OrderOutboxPublisher,
} from '../services/order-service/src/index.js';

const RABBITMQ_URL = process.env.RABBITMQ_URL;
const ORDER_BOOTSTRAP = resolve('services/order-service/bootstrap');
const ORDER_ID = '8e1dfcec-8e3d-4bb1-8a73-ec85c2f7e6da';
const EVENT_ID = '520470e6-0c85-4bf4-8cd2-73c217b02e48';
const OCCURRED_AT = new Date('2026-09-23T15:00:00.000Z');
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

async function waitForMessage(channel: Channel, timeoutMs = 5_000): Promise<GetMessage> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const message = await channel.get(NOTIFICATION_QUEUE, { noAck: false });

    if (message !== false) {
      return message;
    }

    await new Promise<void>((resolveTimeout) => {
      setTimeout(resolveTimeout, 25);
    });
  }

  throw new Error(`RabbitMQ message did not arrive within ${String(timeoutMs)}ms`);
}

const describeWithRabbitMq = RABBITMQ_URL === undefined ? describe.skip : describe;

describeWithRabbitMq('real RabbitMQ order outbox publishing', () => {
  it('publishes a newly created order and records broker confirmation', async () => {
    if (RABBITMQ_URL === undefined) {
      throw new Error('RABBITMQ_URL is required for the RabbitMQ integration test');
    }

    const mongoServer = await MongoMemoryServer.create({
      binary: { downloadDir: resolve('.cache/mongodb-binaries') },
    });
    const mongoClient = createMongoClient({
      uri: mongoServer.getUri(),
      applicationName: 'rabbitmq-integration-tests',
    });
    const rabbitConnection = await connectAmqp(RABBITMQ_URL);
    const publishChannel = await rabbitConnection.createConfirmChannel();
    const readChannel = await rabbitConnection.createChannel();

    try {
      await connectMongo(mongoClient);
      const database = mongoClient.db('rabbitmq_order_publish_test');
      await applyBootstrap(database, ORDER_BOOTSTRAP);
      await assertRabbitMqTopology(publishChannel);
      await readChannel.purgeQueue(NOTIFICATION_QUEUE);

      const orders = new MongoOrderRepository(database);
      const service = new OrderManagementService(orders, {
        clock: () => OCCURRED_AT,
        eventIdGenerator: () => EVENT_ID,
        orderIdGenerator: () => ORDER_ID,
      });
      const createdOrder = await service.createOrder({
        customerId: 'rabbitmq-integration-customer',
        currency: 'CAD',
        items: [{ productId: 'product-1', quantity: 2, unitPriceCents: 1_250 }],
        correlationId: 'rabbitmq-integration-request',
        traceContext: { traceparent: TRACEPARENT, tracestate: 'vendor=value' },
      });
      const publisher = new OrderOutboxPublisher(
        new MongoOrderOutboxRepository(database),
        {
          channel: () => publishChannel,
          exchange: ORDER_EVENTS_EXCHANGE,
          routingKey: ORDER_CREATED_ROUTING_KEY,
        },
        {
          clock: () => new Date('2026-09-23T15:00:01.000Z'),
          lockTokenGenerator: () => 'rabbitmq-integration-worker',
        },
      );

      await expect(publisher.publishNext()).resolves.toBe(true);
      const message = await waitForMessage(readChannel);
      const event: unknown = JSON.parse(message.content.toString('utf8'));

      expect(event).toEqual({
        eventId: EVENT_ID,
        eventType: 'order.created',
        eventVersion: 1,
        occurredAt: OCCURRED_AT.toISOString(),
        correlationId: 'rabbitmq-integration-request',
        traceContext: { traceparent: TRACEPARENT, tracestate: 'vendor=value' },
        payload: { order: createdOrder },
      });
      expect(message.fields).toMatchObject({
        exchange: ORDER_EVENTS_EXCHANGE,
        routingKey: ORDER_CREATED_ROUTING_KEY,
      });
      expect(message.properties).toMatchObject({
        contentEncoding: 'utf-8',
        contentType: 'application/json',
        correlationId: 'rabbitmq-integration-request',
        deliveryMode: 2,
        headers: {
          traceparent: TRACEPARENT,
          tracestate: 'vendor=value',
          'x-correlation-id': 'rabbitmq-integration-request',
          'x-event-version': 1,
          'x-publish-attempt': 1,
        },
        messageId: EVENT_ID,
        type: 'order.created',
      });
      await expect(
        database.collection<{ _id: string }>('orders').findOne({ _id: ORDER_ID }),
      ).resolves.toMatchObject({
        outbox: {
          lockToken: null,
          publishedAt: new Date('2026-09-23T15:00:01.000Z'),
        },
      });
      readChannel.ack(message);
    } finally {
      await readChannel.close();
      await publishChannel.close();
      await rabbitConnection.close();
      await closeMongo(mongoClient);
      await mongoServer.stop();
    }
  }, 180_000);
});
