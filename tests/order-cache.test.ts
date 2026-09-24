import { describe, expect, it, type Mock, vi } from 'vitest';

import {
  OrderCache,
  orderCacheKey,
  parseOrderCacheConfiguration,
  type OrderCacheClient,
  type RepositoryOrder,
} from '../services/order-service/src/index.js';

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

interface CacheClientFixture {
  readonly client: OrderCacheClient;
  readonly del: Mock<OrderCacheClient['del']>;
  readonly get: Mock<OrderCacheClient['get']>;
  readonly set: Mock<OrderCacheClient['set']>;
}

function createClientFixture(): CacheClientFixture {
  const del = vi.fn<OrderCacheClient['del']>().mockResolvedValue(1);
  const get = vi.fn<OrderCacheClient['get']>().mockResolvedValue(null);
  const set = vi.fn<OrderCacheClient['set']>().mockResolvedValue('OK');
  return { client: { del, get, set }, del, get, set };
}

describe('order cache configuration and keys', () => {
  it('uses versioned namespaced keys', () => {
    expect(orderCacheKey(ORDER.id)).toBe(`order-service:v1:orders:${ORDER.id}`);
  });

  it('uses safe defaults and accepts benchmark overrides', () => {
    expect(parseOrderCacheConfiguration({})).toEqual({ enabled: true, ttlSeconds: 60 });
    expect(
      parseOrderCacheConfiguration({ CACHE_ENABLED: 'false', CACHE_TTL_SECONDS: '300' }),
    ).toEqual({ enabled: false, ttlSeconds: 300 });
  });

  it.each([
    { CACHE_ENABLED: 'yes' },
    { CACHE_TTL_SECONDS: '0' },
    { CACHE_TTL_SECONDS: '1.5' },
    { CACHE_TTL_SECONDS: '86401' },
  ])('rejects invalid cache configuration: %o', (environment) => {
    expect(() => parseOrderCacheConfiguration(environment)).toThrow();
  });
});

describe('OrderCache', () => {
  it('returns a validated cache hit', async () => {
    const fixture = createClientFixture();
    fixture.get.mockResolvedValue(JSON.stringify(ORDER));
    const cache = new OrderCache(fixture.client, { enabled: true, ttlSeconds: 60 });

    await expect(cache.get(ORDER.id)).resolves.toEqual({ status: 'hit', order: ORDER });
    expect(fixture.get).toHaveBeenCalledWith(orderCacheKey(ORDER.id));
  });

  it('returns a miss when the key does not exist', async () => {
    const fixture = createClientFixture();
    const cache = new OrderCache(fixture.client, { enabled: true, ttlSeconds: 60 });

    await expect(cache.get(ORDER.id)).resolves.toEqual({ status: 'miss', order: null });
  });

  it('deletes malformed or invalid cached data and treats it as a miss', async () => {
    const fixture = createClientFixture();
    fixture.get.mockResolvedValue('{"id":"not-a-valid-order"}');
    const cache = new OrderCache(fixture.client, { enabled: true, ttlSeconds: 60 });

    await expect(cache.get(ORDER.id)).resolves.toEqual({ status: 'miss', order: null });
    expect(fixture.del).toHaveBeenCalledWith(orderCacheKey(ORDER.id));
  });

  it('writes serialized orders with the configured expiration', async () => {
    const fixture = createClientFixture();
    const cache = new OrderCache(fixture.client, { enabled: true, ttlSeconds: 120 });

    await cache.set(ORDER);

    expect(fixture.set).toHaveBeenCalledWith(orderCacheKey(ORDER.id), JSON.stringify(ORDER), {
      expiration: { type: 'EX', value: 120 },
    });
  });

  it('deletes an order by its versioned key', async () => {
    const fixture = createClientFixture();
    const cache = new OrderCache(fixture.client, { enabled: true, ttlSeconds: 60 });

    await cache.delete(ORDER.id);

    expect(fixture.del).toHaveBeenCalledWith(orderCacheKey(ORDER.id));
  });

  it('bypasses every Redis operation when caching is disabled', async () => {
    const fixture = createClientFixture();
    const cache = new OrderCache(fixture.client, { enabled: false, ttlSeconds: 60 });

    await expect(cache.get(ORDER.id)).resolves.toEqual({ status: 'bypass', order: null });
    await cache.set(ORDER);
    await cache.delete(ORDER.id);

    expect(fixture.get).not.toHaveBeenCalled();
    expect(fixture.set).not.toHaveBeenCalled();
    expect(fixture.del).not.toHaveBeenCalled();
  });
});
