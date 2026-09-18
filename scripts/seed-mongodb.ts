import { resolve } from 'node:path';

import type { Collection, Document } from 'mongodb';

import { applyBootstrap } from '../packages/platform/src/bootstrap.js';
import { closeMongo, connectMongo, createMongoClient } from '../packages/platform/src/mongodb.js';

const BENCHMARK_ORDER_ID = '00000000-0000-4000-8000-000000000001';

interface SeedOrderDocument extends Document {
  readonly _id: string;
  readonly customerId: string;
  readonly status: 'confirmed';
  readonly currency: 'CAD';
  readonly items: readonly {
    readonly productId: string;
    readonly quantity: number;
    readonly unitPriceCents: number;
  }[];
  readonly totalCents: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

async function seedOrder(collection: Collection<SeedOrderDocument>): Promise<void> {
  const timestamp = new Date('2026-01-01T00:00:00.000Z');
  await collection.updateOne(
    { _id: BENCHMARK_ORDER_ID },
    {
      $setOnInsert: {
        _id: BENCHMARK_ORDER_ID,
        customerId: 'benchmark-customer',
        status: 'confirmed',
        currency: 'CAD',
        items: [{ productId: 'benchmark-product', quantity: 1, unitPriceCents: 2_500 }],
        totalCents: 2_500,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
    { upsert: true },
  );
}

async function main(): Promise<void> {
  const client = createMongoClient({
    uri: requiredEnvironmentVariable('ORDER_MONGODB_URI'),
    applicationName: 'order-service-seed',
  });

  try {
    await connectMongo(client);
    const database = client.db(requiredEnvironmentVariable('ORDER_MONGODB_DATABASE'));
    await applyBootstrap(database, resolve('services/order-service/bootstrap'));
    await seedOrder(database.collection<SeedOrderDocument>('orders'));
    process.stdout.write(
      `${JSON.stringify({ message: 'benchmark order seeded', orderId: BENCHMARK_ORDER_ID })}\n`,
    );
  } finally {
    await closeMongo(client);
  }
}

try {
  await main();
} catch (error: unknown) {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', message: 'MongoDB seed failed', error: String(error) })}\n`,
  );
  process.exitCode = 1;
}
