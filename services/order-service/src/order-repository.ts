import type { Collection, Db, Document } from 'mongodb';

export interface RepositoryOrderItem {
  readonly productId: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
}

export interface RepositoryOrder {
  readonly id: string;
  readonly customerId: string;
  readonly status: 'pending' | 'confirmed' | 'cancelled';
  readonly currency: string;
  readonly items: readonly RepositoryOrderItem[];
  readonly totalCents: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RepositoryOrderCreatedEvent {
  readonly eventId: string;
  readonly eventType: 'order.created';
  readonly eventVersion: 1;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly traceContext: Readonly<Record<string, string>>;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface OrderRepository {
  create(order: RepositoryOrder, event: RepositoryOrderCreatedEvent): Promise<RepositoryOrder>;
  findById(orderId: string): Promise<RepositoryOrder | null>;
}

interface OrderDocument extends Document {
  readonly _id: string;
  readonly customerId: string;
  readonly status: RepositoryOrder['status'];
  readonly currency: string;
  readonly items: readonly RepositoryOrderItem[];
  readonly totalCents: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly outbox: {
    readonly eventId: string;
    readonly eventType: 'order.created';
    readonly eventVersion: 1;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly traceContext: Readonly<Record<string, string>>;
    readonly correlationId: string;
    readonly occurredAt: Date;
    readonly publishedAt: Date | null;
    readonly publishAttempts: number;
    readonly nextAttemptAt: Date;
    readonly lastError: string | null;
    readonly lockedAt: Date | null;
    readonly lockToken: string | null;
  };
}

function toRepositoryOrder(document: OrderDocument): RepositoryOrder {
  return {
    id: document._id,
    customerId: document.customerId,
    status: document.status,
    currency: document.currency,
    items: document.items,
    totalCents: document.totalCents,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
}

export class MongoOrderRepository implements OrderRepository {
  readonly #orders: Collection<OrderDocument>;

  public constructor(database: Db) {
    this.#orders = database.collection<OrderDocument>('orders');
  }

  public async create(
    order: RepositoryOrder,
    event: RepositoryOrderCreatedEvent,
  ): Promise<RepositoryOrder> {
    const occurredAt = new Date(event.occurredAt);
    const document: OrderDocument = {
      _id: order.id,
      customerId: order.customerId,
      status: order.status,
      currency: order.currency,
      items: order.items,
      totalCents: order.totalCents,
      createdAt: new Date(order.createdAt),
      updatedAt: new Date(order.updatedAt),
      outbox: {
        eventId: event.eventId,
        eventType: event.eventType,
        eventVersion: event.eventVersion,
        payload: event.payload,
        traceContext: event.traceContext,
        correlationId: event.correlationId,
        occurredAt,
        publishedAt: null,
        publishAttempts: 0,
        nextAttemptAt: occurredAt,
        lastError: null,
        lockedAt: null,
        lockToken: null,
      },
    };

    await this.#orders.insertOne(document);
    return toRepositoryOrder(document);
  }

  public async findById(orderId: string): Promise<RepositoryOrder | null> {
    const document = await this.#orders.findOne({ _id: orderId });
    return document === null ? null : toRepositoryOrder(document);
  }
}
