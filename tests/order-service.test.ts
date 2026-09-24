import { describe, expect, it, type Mock, vi } from 'vitest';

import {
  OrderManagementService,
  type OrderCacheReadResult,
  type OrderRepository,
  type OrderServiceLogger,
  type RepositoryOrder,
} from '../services/order-service/src/index.js';

const STORED_ORDER: RepositoryOrder = {
  id: 'a2dcadf0-888e-4d8c-bbfa-b01e95bc38b6',
  customerId: 'customer-1',
  status: 'pending',
  currency: 'CAD',
  items: [{ productId: 'product-1', quantity: 2, unitPriceCents: 1_250 }],
  totalCents: 2_500,
  createdAt: '2026-09-18T12:00:00.000Z',
  updatedAt: '2026-09-18T12:00:00.000Z',
};

function createRepository(): {
  readonly create: ReturnType<typeof vi.fn<OrderRepository['create']>>;
  readonly findById: ReturnType<typeof vi.fn<OrderRepository['findById']>>;
  readonly repository: OrderRepository;
} {
  const create = vi
    .fn<OrderRepository['create']>()
    .mockImplementation((order) => Promise.resolve(order));
  const findById = vi.fn<OrderRepository['findById']>().mockResolvedValue(null);
  return { create, findById, repository: { create, findById } };
}

interface CacheFixture {
  readonly cache: {
    get(orderId: string): Promise<OrderCacheReadResult>;
    set(order: RepositoryOrder): Promise<void>;
  };
  readonly get: Mock<(orderId: string) => Promise<OrderCacheReadResult>>;
  readonly set: Mock<(order: RepositoryOrder) => Promise<void>>;
}

function createCache(): CacheFixture {
  const get = vi
    .fn<(orderId: string) => Promise<OrderCacheReadResult>>()
    .mockResolvedValue({ status: 'miss', order: null });
  const set = vi.fn<(order: RepositoryOrder) => Promise<void>>().mockResolvedValue(undefined);
  return { cache: { get, set }, get, set };
}

function createLogger(): {
  readonly info: Mock<OrderServiceLogger['info']>;
  readonly logger: OrderServiceLogger;
  readonly warn: Mock<OrderServiceLogger['warn']>;
} {
  const info = vi.fn<OrderServiceLogger['info']>();
  const warn = vi.fn<OrderServiceLogger['warn']>();
  return { info, logger: { info, warn }, warn };
}

describe('OrderManagementService', () => {
  it('calculates the total and persists the order with its event', async () => {
    const { create, repository } = createRepository();
    const { cache, set } = createCache();
    const service = new OrderManagementService(repository, {
      cache,
      clock: () => new Date('2026-09-18T12:00:00.000Z'),
      eventIdGenerator: () => '066037b6-2f0d-4b67-b0f0-11763e346fec',
      orderIdGenerator: () => 'a2dcadf0-888e-4d8c-bbfa-b01e95bc38b6',
    });

    await expect(
      service.createOrder({
        customerId: 'customer-1',
        currency: 'CAD',
        items: [{ productId: 'product-1', quantity: 2, unitPriceCents: 1_250 }],
        correlationId: 'request-1',
        traceContext: {
          traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        },
      }),
    ).resolves.toEqual(STORED_ORDER);
    expect(create).toHaveBeenCalledWith(STORED_ORDER, {
      eventId: '066037b6-2f0d-4b67-b0f0-11763e346fec',
      eventType: 'order.created',
      eventVersion: 1,
      occurredAt: '2026-09-18T12:00:00.000Z',
      correlationId: 'request-1',
      traceContext: {
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
      payload: { order: STORED_ORDER },
    });
    expect(set).toHaveBeenCalledWith(STORED_ORDER);
  });

  it('returns an order only to its owning customer', async () => {
    const { findById, repository } = createRepository();
    findById.mockResolvedValue(STORED_ORDER);
    const service = new OrderManagementService(repository);

    await expect(service.findOrder(STORED_ORDER.id, 'customer-1')).resolves.toEqual(STORED_ORDER);
    await expect(service.findOrder(STORED_ORDER.id, 'customer-2')).resolves.toBeNull();
  });

  it('returns null when the repository cannot find the order', async () => {
    const service = new OrderManagementService(createRepository().repository);

    await expect(service.findOrder(STORED_ORDER.id, 'customer-1')).resolves.toBeNull();
  });

  it('propagates repository failures without reporting a successful order', async () => {
    const { create, repository } = createRepository();
    create.mockRejectedValue(new Error('database unavailable'));
    const service = new OrderManagementService(repository);

    await expect(
      service.createOrder({
        customerId: 'customer-1',
        currency: 'CAD',
        items: [{ productId: 'product-1', quantity: 1, unitPriceCents: 100 }],
        correlationId: 'request-1',
        traceContext: { traceparent: 'trace-context' },
      }),
    ).rejects.toThrow('database unavailable');
  });

  it('returns a cache hit without querying MongoDB', async () => {
    const { findById, repository } = createRepository();
    const { cache, get } = createCache();
    const { info, logger } = createLogger();
    get.mockResolvedValue({ status: 'hit', order: STORED_ORDER });
    const service = new OrderManagementService(repository, { cache, logger });

    await expect(service.findOrder(STORED_ORDER.id, 'customer-1')).resolves.toEqual(STORED_ORDER);
    expect(findById).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      { cacheStatus: 'hit', orderId: STORED_ORDER.id },
      'Order cache hit',
    );
  });

  it('does not expose a cached order to a different customer', async () => {
    const { findById, repository } = createRepository();
    const { cache, get } = createCache();
    get.mockResolvedValue({ status: 'hit', order: STORED_ORDER });
    const service = new OrderManagementService(repository, { cache });

    await expect(service.findOrder(STORED_ORDER.id, 'customer-2')).resolves.toBeNull();
    expect(findById).not.toHaveBeenCalled();
  });

  it('loads a cache miss from MongoDB and populates the cache', async () => {
    const { findById, repository } = createRepository();
    const { cache, set } = createCache();
    const { info, logger } = createLogger();
    findById.mockResolvedValue(STORED_ORDER);
    const service = new OrderManagementService(repository, { cache, logger });

    await expect(service.findOrder(STORED_ORDER.id, 'customer-1')).resolves.toEqual(STORED_ORDER);
    expect(set).toHaveBeenCalledWith(STORED_ORDER);
    expect(info).toHaveBeenCalledWith(
      { cacheStatus: 'miss', orderId: STORED_ORDER.id },
      'Order cache miss',
    );
  });

  it('falls back to MongoDB when a Redis read fails', async () => {
    const { findById, repository } = createRepository();
    const { cache, get } = createCache();
    const { logger, warn } = createLogger();
    const redisError = new Error('Redis unavailable');
    get.mockRejectedValue(redisError);
    findById.mockResolvedValue(STORED_ORDER);
    const service = new OrderManagementService(repository, { cache, logger });

    await expect(service.findOrder(STORED_ORDER.id, 'customer-1')).resolves.toEqual(STORED_ORDER);
    expect(findById).toHaveBeenCalledWith(STORED_ORDER.id);
    expect(warn).toHaveBeenCalledWith(
      {
        cacheStatus: 'error',
        err: redisError,
        operation: 'read',
        orderId: STORED_ORDER.id,
      },
      'Order cache read failed; falling back to MongoDB',
    );
  });

  it('returns a created order even when Redis population fails', async () => {
    const { repository } = createRepository();
    const { cache, set } = createCache();
    const { logger, warn } = createLogger();
    const redisError = new Error('Redis unavailable');
    set.mockRejectedValue(redisError);
    const service = new OrderManagementService(repository, {
      cache,
      clock: () => new Date('2026-09-18T12:00:00.000Z'),
      eventIdGenerator: () => '066037b6-2f0d-4b67-b0f0-11763e346fec',
      logger,
      orderIdGenerator: () => STORED_ORDER.id,
    });

    await expect(
      service.createOrder({
        customerId: 'customer-1',
        currency: 'CAD',
        items: STORED_ORDER.items,
        correlationId: 'request-1',
        traceContext: { traceparent: 'trace-context' },
      }),
    ).resolves.toEqual(STORED_ORDER);
    expect(warn).toHaveBeenCalledWith(
      {
        cacheStatus: 'error',
        err: redisError,
        operation: 'write',
        orderId: STORED_ORDER.id,
        source: 'create',
      },
      'Order cache write failed; continuing with MongoDB result',
    );
  });

  it('logs a bypass when no cache is configured', async () => {
    const { findById, repository } = createRepository();
    const { info, logger } = createLogger();
    findById.mockResolvedValue(STORED_ORDER);
    const service = new OrderManagementService(repository, { logger });

    await expect(service.findOrder(STORED_ORDER.id, 'customer-1')).resolves.toEqual(STORED_ORDER);
    expect(info).toHaveBeenCalledWith(
      { cacheStatus: 'bypass', orderId: STORED_ORDER.id, reason: 'not-configured' },
      'Order cache read bypassed',
    );
  });
});
