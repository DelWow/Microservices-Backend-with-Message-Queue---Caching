import { resolve } from 'node:path';

import { MongoServerError, type MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  applyBootstrap,
  checkMongoReadiness,
  closeMongo,
  connectMongo,
  createMongoClient,
  isMongoDuplicateKeyError,
  withMongoTransaction,
} from '../packages/platform/src/index.js';
import { MongoNotificationRepository } from '../services/notification-service/src/index.js';
import {
  MongoOrderOutboxRepository,
  MongoOrderRepository,
  type RepositoryOrder,
  type RepositoryOrderCreatedEvent,
} from '../services/order-service/src/index.js';

process.env.MONGOMS_DOWNLOAD_DIR ??= resolve('.cache/mongodb-binaries');

const ORDER_BOOTSTRAP = resolve('services/order-service/bootstrap');
const NOTIFICATION_BOOTSTRAP = resolve('services/notification-service/bootstrap');

interface BootstrapHistoryDocument {
  readonly _id: number;
  readonly filename: string;
  readonly checksum: string;
  readonly appliedAt: Date;
}

let replicaSet: MongoMemoryReplSet | undefined;
let client: MongoClient | undefined;

function connectedClient(): MongoClient {
  if (client === undefined) {
    throw new Error('MongoDB test client is not connected');
  }

  return client;
}

beforeAll(async () => {
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  client = createMongoClient({
    uri: replicaSet.getUri(),
    applicationName: 'mongodb-integration-tests',
    serverSelectionTimeoutMs: 30_000,
  });
  await connectMongo(client);
}, 180_000);

afterAll(async () => {
  if (client !== undefined) {
    await closeMongo(client);
  }

  if (replicaSet !== undefined) {
    await replicaSet.stop();
  }
});

describe('real MongoDB bootstrap', () => {
  it('creates collections and explicit indexes idempotently', async () => {
    const orderDatabase = connectedClient().db('orders_bootstrap_test');
    const notificationDatabase = connectedClient().db('notifications_bootstrap_test');

    await expect(applyBootstrap(orderDatabase, ORDER_BOOTSTRAP)).resolves.toEqual({
      applied: ['001_collections.json', '002_outbox_claims.json'],
      skipped: [],
    });
    await expect(applyBootstrap(orderDatabase, ORDER_BOOTSTRAP)).resolves.toEqual({
      applied: [],
      skipped: ['001_collections.json', '002_outbox_claims.json'],
    });
    await applyBootstrap(notificationDatabase, NOTIFICATION_BOOTSTRAP);

    const orderIndexNames = (await orderDatabase.collection('orders').indexes()).map(
      (index) => index.name,
    );
    const processedEventIndexes = await notificationDatabase
      .collection('processed_events')
      .indexes();

    expect(orderIndexNames).toEqual(
      expect.arrayContaining([
        '_id_',
        'orders_customer_created_at',
        'orders_status_created_at',
        'orders_outbox_pending',
        'orders_outbox_unpublished',
      ]),
    );
    expect(processedEventIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'processed_events_event_id_unique', unique: true }),
      ]),
    );
  });

  it('reports readiness against the disposable MongoDB process', async () => {
    await expect(checkMongoReadiness(connectedClient())).resolves.toMatchObject({
      latencyMs: expect.any(Number) as number,
    });
  });

  it('rejects checksum drift in an applied bootstrap', async () => {
    const database = connectedClient().db('bootstrap_checksum_test');
    await applyBootstrap(database, ORDER_BOOTSTRAP);
    await database
      .collection<BootstrapHistoryDocument>('_bootstrap_versions')
      .updateOne({ _id: 1 }, { $set: { checksum: '0'.repeat(64) } });

    await expect(applyBootstrap(database, ORDER_BOOTSTRAP)).rejects.toThrow(
      'Applied bootstrap checksum changed',
    );
  });

  it('rejects applied bootstrap history missing from the repository', async () => {
    const database = connectedClient().db('bootstrap_missing_test');
    await applyBootstrap(database, ORDER_BOOTSTRAP);
    await database.collection<BootstrapHistoryDocument>('_bootstrap_versions').insertOne({
      _id: 3,
      filename: '003_missing.json',
      checksum: '0'.repeat(64),
      appliedAt: new Date(),
    });

    await expect(applyBootstrap(database, ORDER_BOOTSTRAP)).rejects.toThrow(
      'Applied bootstrap is missing locally',
    );
  });
});

describe('notification idempotency transaction', () => {
  it('records one outcome and catches E11000 on duplicate processed-event insertion', async () => {
    const mongoClient = connectedClient();
    const database = mongoClient.db('notification_duplicate_test');
    await applyBootstrap(database, NOTIFICATION_BOOTSTRAP);
    const repository = new MongoNotificationRepository(mongoClient, database);
    const input = {
      notificationId: 'notification-1',
      eventId: 'event-1',
      eventType: 'order.created',
      eventVersion: 1,
      orderId: 'order-1',
      customerId: 'customer-1',
      channel: 'log',
      status: 'sent',
      message: 'Order order-1 was created',
      processedAt: new Date('2026-09-18T12:00:00.000Z'),
    } as const;

    await expect(repository.recordDelivery(input)).resolves.toBe('recorded');
    await expect(
      repository.recordDelivery({ ...input, notificationId: 'notification-2' }),
    ).resolves.toBe('duplicate');
    await expect(database.collection('processed_events').countDocuments()).resolves.toBe(1);
    await expect(database.collection('notifications').countDocuments()).resolves.toBe(1);
  });

  it('rolls back the idempotency marker when the audit document is invalid', async () => {
    const mongoClient = connectedClient();
    const database = mongoClient.db('notification_rollback_test');
    await applyBootstrap(database, NOTIFICATION_BOOTSTRAP);
    const repository = new MongoNotificationRepository(mongoClient, database);

    await expect(
      repository.recordDelivery({
        notificationId: 'notification-invalid',
        eventId: 'event-invalid',
        eventType: 'order.created',
        eventVersion: 1,
        orderId: 'order-invalid',
        customerId: 'customer-invalid',
        channel: 'log',
        status: 'sent',
        message: '',
        processedAt: new Date('2026-09-18T12:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(MongoServerError);
    await expect(
      database.collection('processed_events').countDocuments({ eventId: 'event-invalid' }),
    ).resolves.toBe(0);
  });

  it('supports shared transaction helpers and duplicate-key classification', async () => {
    const mongoClient = connectedClient();
    const database = mongoClient.db('mongo_helper_test');
    const collection = database.collection<{ _id: string }>('unique_documents');

    await withMongoTransaction(mongoClient, async (session) => {
      await collection.insertOne({ _id: 'only-once' }, { session });
    });

    try {
      await collection.insertOne({ _id: 'only-once' });
      throw new Error('Expected duplicate insertion to fail');
    } catch (error: unknown) {
      expect(isMongoDuplicateKeyError(error)).toBe(true);
    }
  });
});

describe('MongoDB order repository', () => {
  const order: RepositoryOrder = {
    id: 'a2dcadf0-888e-4d8c-bbfa-b01e95bc38b6',
    customerId: 'customer-1',
    status: 'pending',
    currency: 'CAD',
    items: [{ productId: 'product-1', quantity: 2, unitPriceCents: 1_250 }],
    totalCents: 2_500,
    createdAt: '2026-09-18T12:00:00.000Z',
    updatedAt: '2026-09-18T12:00:00.000Z',
  };
  const event: RepositoryOrderCreatedEvent = {
    eventId: '066037b6-2f0d-4b67-b0f0-11763e346fec',
    eventType: 'order.created',
    eventVersion: 1,
    occurredAt: '2026-09-18T12:00:00.000Z',
    correlationId: 'request-1',
    traceContext: {
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    },
    payload: { order },
  };

  it('creates an order with its outbox atomically and reads the public order shape', async () => {
    const database = connectedClient().db('order_repository_create_test');
    await applyBootstrap(database, ORDER_BOOTSTRAP);
    const repository = new MongoOrderRepository(database);

    await expect(repository.create(order, event)).resolves.toEqual(order);
    await expect(repository.findById(order.id)).resolves.toEqual(order);

    const stored = await database.collection<{ _id: string }>('orders').findOne({ _id: order.id });
    expect(stored).toMatchObject({
      _id: order.id,
      createdAt: new Date(order.createdAt),
      outbox: {
        eventId: event.eventId,
        lockedAt: null,
        lockToken: null,
        publishedAt: null,
        publishAttempts: 0,
        nextAttemptAt: new Date(event.occurredAt),
      },
    });
  });

  it('claims, retries, and publishes an outbox event atomically', async () => {
    const database = connectedClient().db('order_outbox_claim_test');
    await applyBootstrap(database, ORDER_BOOTSTRAP);
    await new MongoOrderRepository(database).create(order, event);
    const outbox = new MongoOrderOutboxRepository(database);
    const initialTime = new Date(event.occurredAt);

    const firstClaim = await outbox.claimNext(initialTime, 'worker-1', 30_000);
    expect(firstClaim).toMatchObject({
      event,
      lockToken: 'worker-1',
      orderId: order.id,
      publishAttempts: 0,
    });
    await expect(outbox.claimNext(initialTime, 'worker-2', 30_000)).resolves.toBeNull();

    if (firstClaim === null) {
      throw new Error('Expected the pending outbox event to be claimed');
    }

    const retryAt = new Date('2026-09-18T12:00:01.000Z');
    await outbox.markFailed(firstClaim, retryAt, 'broker unavailable');
    await expect(
      outbox.claimNext(new Date('2026-09-18T12:00:00.999Z'), 'worker-2', 30_000),
    ).resolves.toBeNull();

    const retryClaim = await outbox.claimNext(retryAt, 'worker-2', 30_000);
    expect(retryClaim).toMatchObject({ publishAttempts: 1, lockToken: 'worker-2' });

    if (retryClaim === null) {
      throw new Error('Expected the failed outbox event to become claimable');
    }

    const publishedAt = new Date('2026-09-18T12:00:02.000Z');
    await outbox.markPublished(retryClaim, publishedAt);
    await expect(
      outbox.claimNext(new Date('2026-09-18T12:01:00.000Z'), 'worker-3', 30_000),
    ).resolves.toBeNull();
    await expect(
      database.collection<{ _id: string }>('orders').findOne({ _id: order.id }),
    ).resolves.toMatchObject({
      outbox: {
        lastError: null,
        lockedAt: null,
        lockToken: null,
        publishAttempts: 1,
        publishedAt,
      },
    });
  });

  it('reclaims a stale outbox lease and rejects updates from the old owner', async () => {
    const database = connectedClient().db('order_outbox_stale_claim_test');
    await applyBootstrap(database, ORDER_BOOTSTRAP);
    await new MongoOrderRepository(database).create(order, event);
    const outbox = new MongoOrderOutboxRepository(database);
    const firstClaim = await outbox.claimNext(new Date(event.occurredAt), 'worker-1', 30_000);
    const secondClaim = await outbox.claimNext(
      new Date('2026-09-18T12:00:30.001Z'),
      'worker-2',
      30_000,
    );

    expect(secondClaim).toMatchObject({ lockToken: 'worker-2' });
    if (firstClaim === null || secondClaim === null) {
      throw new Error('Expected both lease claims to succeed');
    }

    await expect(
      outbox.markPublished(firstClaim, new Date('2026-09-18T12:00:31.000Z')),
    ).rejects.toThrow(`Order outbox claim was lost for event ${event.eventId}`);
    await expect(
      outbox.markPublished(secondClaim, new Date('2026-09-18T12:00:31.000Z')),
    ).resolves.toBeUndefined();
  });

  it('returns null when an order does not exist', async () => {
    const database = connectedClient().db('order_repository_missing_test');
    await applyBootstrap(database, ORDER_BOOTSTRAP);
    const repository = new MongoOrderRepository(database);

    await expect(repository.findById('missing-order')).resolves.toBeNull();
  });

  it('leaves the original order intact when a duplicate ID is inserted', async () => {
    const database = connectedClient().db('order_repository_duplicate_test');
    await applyBootstrap(database, ORDER_BOOTSTRAP);
    const repository = new MongoOrderRepository(database);
    await repository.create(order, event);

    await expect(repository.create(order, { ...event, eventId: 'event-2' })).rejects.toMatchObject({
      code: 11_000,
    });
    await expect(database.collection('orders').countDocuments()).resolves.toBe(1);
    await expect(repository.findById(order.id)).resolves.toEqual(order);
  });
});
