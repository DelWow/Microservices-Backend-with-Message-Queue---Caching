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
      applied: ['001_collections.json'],
      skipped: [],
    });
    await expect(applyBootstrap(orderDatabase, ORDER_BOOTSTRAP)).resolves.toEqual({
      applied: [],
      skipped: ['001_collections.json'],
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
      _id: 2,
      filename: '002_missing.json',
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
