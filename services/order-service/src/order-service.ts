import { randomUUID } from 'node:crypto';

import type { OrderCache, OrderCacheReadResult } from './order-cache.js';
import type {
  OrderRepository,
  RepositoryOrder,
  RepositoryOrderCreatedEvent,
  RepositoryOrderItem,
} from './order-repository.js';

export interface CreateOrderCommand {
  readonly customerId: string;
  readonly currency: string;
  readonly items: readonly RepositoryOrderItem[];
  readonly correlationId: string;
  readonly traceContext: Readonly<Record<string, string>>;
}

export interface OrderManagementServiceDependencies {
  readonly cache?: Pick<OrderCache, 'get' | 'set'>;
  readonly clock?: () => Date;
  readonly eventIdGenerator?: () => string;
  readonly logger?: OrderServiceLogger;
  readonly orderIdGenerator?: () => string;
}

export interface OrderServiceLogger {
  info(bindings: Readonly<Record<string, unknown>>, message: string): void;
  warn(bindings: Readonly<Record<string, unknown>>, message: string): void;
}

export class OrderManagementService {
  readonly #cache: Pick<OrderCache, 'get' | 'set'> | undefined;
  readonly #clock: () => Date;
  readonly #eventIdGenerator: () => string;
  readonly #logger: OrderServiceLogger | undefined;
  readonly #orderIdGenerator: () => string;
  readonly #repository: OrderRepository;

  public constructor(
    repository: OrderRepository,
    dependencies: OrderManagementServiceDependencies = {},
  ) {
    this.#repository = repository;
    this.#cache = dependencies.cache;
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#eventIdGenerator = dependencies.eventIdGenerator ?? randomUUID;
    this.#logger = dependencies.logger;
    this.#orderIdGenerator = dependencies.orderIdGenerator ?? randomUUID;
  }

  async #populateCache(order: RepositoryOrder, source: 'create' | 'database'): Promise<void> {
    if (this.#cache === undefined) {
      return;
    }

    try {
      await this.#cache.set(order);
    } catch (error: unknown) {
      this.#logger?.warn(
        { cacheStatus: 'error', err: error, operation: 'write', orderId: order.id, source },
        'Order cache write failed; continuing with MongoDB result',
      );
    }
  }

  async #readCache(orderId: string): Promise<OrderCacheReadResult | null> {
    if (this.#cache === undefined) {
      this.#logger?.info(
        { cacheStatus: 'bypass', orderId, reason: 'not-configured' },
        'Order cache read bypassed',
      );
      return null;
    }

    try {
      const result = await this.#cache.get(orderId);
      this.#logger?.info({ cacheStatus: result.status, orderId }, `Order cache ${result.status}`);
      return result;
    } catch (error: unknown) {
      this.#logger?.warn(
        { cacheStatus: 'error', err: error, operation: 'read', orderId },
        'Order cache read failed; falling back to MongoDB',
      );
      return null;
    }
  }

  public async createOrder(command: CreateOrderCommand): Promise<RepositoryOrder> {
    const timestamp = this.#clock().toISOString();
    const order: RepositoryOrder = {
      id: this.#orderIdGenerator(),
      customerId: command.customerId,
      status: 'pending',
      currency: command.currency,
      items: command.items,
      totalCents: command.items.reduce(
        (total, item) => total + item.quantity * item.unitPriceCents,
        0,
      ),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const event: RepositoryOrderCreatedEvent = {
      eventId: this.#eventIdGenerator(),
      eventType: 'order.created',
      eventVersion: 1,
      occurredAt: timestamp,
      correlationId: command.correlationId,
      traceContext: command.traceContext,
      payload: { order },
    };

    const persistedOrder = await this.#repository.create(order, event);
    await this.#populateCache(persistedOrder, 'create');
    return persistedOrder;
  }

  public async findOrder(orderId: string, customerId: string): Promise<RepositoryOrder | null> {
    const cached = await this.#readCache(orderId);

    if (cached?.status === 'hit') {
      return cached.order.customerId === customerId ? cached.order : null;
    }

    const order = await this.#repository.findById(orderId);

    if (order !== null) {
      await this.#populateCache(order, 'database');
    }

    if (order?.customerId !== customerId) {
      return null;
    }

    return order;
  }
}
