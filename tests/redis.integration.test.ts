import { resolve } from 'node:path';

import { RedisMemoryServer } from 'redis-memory-server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  checkRedisReadiness,
  closeRedis,
  connectRedis,
  createRedisClient,
  type RedisReadiness,
} from '../packages/platform/src/index.js';
import {
  OrderCache,
  OrderManagementService,
  orderCacheKey,
  type OrderRepository,
  type RepositoryOrder,
} from '../services/order-service/src/index.js';

const REDIS_VERSION = '7.2.7';
const ORDER: RepositoryOrder = {
  id: 'a2dcadf0-888e-4d8c-bbfa-b01e95bc38b6',
  customerId: 'customer-1',
  status: 'pending',
  currency: 'CAD',
  items: [{ productId: 'product-1', quantity: 2, unitPriceCents: 1_250 }],
  totalCents: 2_500,
  createdAt: '2026-09-18T12:00:00.000Z',
  updatedAt: '2026-09-18T12:00:00.000Z',
};

let redisServer: RedisMemoryServer | undefined;
let redisClient: ReturnType<typeof createRedisClient> | undefined;

async function waitForExpiration(key: string, timeoutMs = 3_000): Promise<void> {
  if (redisClient === undefined) {
    throw new Error('Redis test client is not connected');
  }

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if ((await redisClient.exists(key)) === 0) {
      return;
    }

    await new Promise<void>((resolveTimeout) => {
      setTimeout(resolveTimeout, 50);
    });
  }

  throw new Error(`Redis key did not expire within ${String(timeoutMs)}ms: ${key}`);
}

beforeAll(async () => {
  redisServer = await RedisMemoryServer.create({
    binary: {
      downloadDir: resolve('.cache/redis-binaries'),
      version: REDIS_VERSION,
    },
  });
  const host = await redisServer.getHost();
  const port = await redisServer.getPort();
  redisClient = createRedisClient({
    applicationName: 'redis-integration-tests',
    onError: () => undefined,
    url: `redis://${host}:${String(port)}`,
  });
  await connectRedis(redisClient);
}, 300_000);

afterAll(async () => {
  if (redisClient !== undefined) {
    await closeRedis(redisClient);
  }

  if (redisServer !== undefined) {
    await redisServer.stop();
  }
});

describe('real Redis order cache', () => {
  it('supports cache-aside reads, TTL expiry, readiness, and outage fallback', async () => {
    if (redisClient === undefined) {
      throw new Error('Redis test client is not connected');
    }

    await expect(checkRedisReadiness(redisClient)).resolves.toMatchObject<RedisReadiness>({
      latencyMs: expect.any(Number) as number,
    });
    const cache = new OrderCache(redisClient, { enabled: true, ttlSeconds: 1 });
    const findById = vi.fn<OrderRepository['findById']>().mockResolvedValue(ORDER);
    const repository: OrderRepository = {
      create: vi.fn<OrderRepository['create']>(),
      findById,
    };
    const service = new OrderManagementService(repository, { cache });

    await expect(service.findOrder(ORDER.id, ORDER.customerId)).resolves.toEqual(ORDER);
    await expect(service.findOrder(ORDER.id, ORDER.customerId)).resolves.toEqual(ORDER);
    expect(findById).toHaveBeenCalledOnce();

    await waitForExpiration(orderCacheKey(ORDER.id));
    await expect(cache.get(ORDER.id)).resolves.toEqual({ status: 'miss', order: null });

    await closeRedis(redisClient);
    await expect(service.findOrder(ORDER.id, ORDER.customerId)).resolves.toEqual(ORDER);
    expect(findById).toHaveBeenCalledTimes(2);
  });
});
