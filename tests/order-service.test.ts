import { describe, expect, it, vi } from 'vitest';

import {
  OrderManagementService,
  type OrderRepository,
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

describe('OrderManagementService', () => {
  it('calculates the total and persists the order with its event', async () => {
    const { create, repository } = createRepository();
    const service = new OrderManagementService(repository, {
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
});
