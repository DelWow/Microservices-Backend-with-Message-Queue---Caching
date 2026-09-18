import { randomUUID } from 'node:crypto';

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
  readonly clock?: () => Date;
  readonly eventIdGenerator?: () => string;
  readonly orderIdGenerator?: () => string;
}

export class OrderManagementService {
  readonly #clock: () => Date;
  readonly #eventIdGenerator: () => string;
  readonly #orderIdGenerator: () => string;
  readonly #repository: OrderRepository;

  public constructor(
    repository: OrderRepository,
    dependencies: OrderManagementServiceDependencies = {},
  ) {
    this.#repository = repository;
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#eventIdGenerator = dependencies.eventIdGenerator ?? randomUUID;
    this.#orderIdGenerator = dependencies.orderIdGenerator ?? randomUUID;
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

    return this.#repository.create(order, event);
  }

  public async findOrder(orderId: string, customerId: string): Promise<RepositoryOrder | null> {
    const order = await this.#repository.findById(orderId);

    if (order?.customerId !== customerId) {
      return null;
    }

    return order;
  }
}
