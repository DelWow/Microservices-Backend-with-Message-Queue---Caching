import type { Collection, Db, Document, Filter } from 'mongodb';

import type { RepositoryOrderCreatedEvent } from './order-repository.js';

export interface ClaimedOrderOutboxEvent {
  readonly event: RepositoryOrderCreatedEvent;
  readonly lockToken: string;
  readonly orderId: string;
  readonly publishAttempts: number;
}

export interface OrderOutboxRepository {
  claimNext(
    now: Date,
    lockToken: string,
    lockTimeoutMs: number,
  ): Promise<ClaimedOrderOutboxEvent | null>;
  markFailed(
    claimed: ClaimedOrderOutboxEvent,
    nextAttemptAt: Date,
    errorMessage: string,
  ): Promise<void>;
  markPublished(claimed: ClaimedOrderOutboxEvent, publishedAt: Date): Promise<void>;
}

interface OrderOutboxDocument extends Document {
  readonly _id: string;
  readonly outbox?: {
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
    readonly lockedAt?: Date | null;
    readonly lockToken?: string | null;
  };
}

function claimFilter(claimed: ClaimedOrderOutboxEvent): Filter<OrderOutboxDocument> {
  return {
    _id: claimed.orderId,
    'outbox.eventId': claimed.event.eventId,
    'outbox.lockToken': claimed.lockToken,
    'outbox.publishedAt': null,
  };
}

function requireMatchedClaim(matchedCount: number, eventId: string): void {
  if (matchedCount !== 1) {
    throw new Error(`Order outbox claim was lost for event ${eventId}`);
  }
}

export class MongoOrderOutboxRepository implements OrderOutboxRepository {
  readonly #orders: Collection<OrderOutboxDocument>;

  public constructor(database: Db) {
    this.#orders = database.collection<OrderOutboxDocument>('orders');
  }

  public async claimNext(
    now: Date,
    lockToken: string,
    lockTimeoutMs: number,
  ): Promise<ClaimedOrderOutboxEvent | null> {
    const staleBefore = new Date(now.getTime() - lockTimeoutMs);
    const document = await this.#orders.findOneAndUpdate(
      {
        'outbox.publishedAt': null,
        'outbox.nextAttemptAt': { $lte: now },
        $or: [{ 'outbox.lockedAt': null }, { 'outbox.lockedAt': { $lte: staleBefore } }],
      },
      {
        $set: {
          'outbox.lockedAt': now,
          'outbox.lockToken': lockToken,
        },
      },
      {
        returnDocument: 'after',
        sort: { 'outbox.nextAttemptAt': 1, 'outbox.occurredAt': 1 },
      },
    );

    if (document?.outbox === undefined) {
      return null;
    }

    return {
      event: {
        eventId: document.outbox.eventId,
        eventType: document.outbox.eventType,
        eventVersion: document.outbox.eventVersion,
        occurredAt: document.outbox.occurredAt.toISOString(),
        correlationId: document.outbox.correlationId,
        traceContext: document.outbox.traceContext,
        payload: document.outbox.payload,
      },
      lockToken,
      orderId: document._id,
      publishAttempts: document.outbox.publishAttempts,
    };
  }

  public async markPublished(claimed: ClaimedOrderOutboxEvent, publishedAt: Date): Promise<void> {
    const result = await this.#orders.updateOne(claimFilter(claimed), {
      $set: {
        'outbox.lastError': null,
        'outbox.lockedAt': null,
        'outbox.lockToken': null,
        'outbox.publishedAt': publishedAt,
      },
    });
    requireMatchedClaim(result.matchedCount, claimed.event.eventId);
  }

  public async markFailed(
    claimed: ClaimedOrderOutboxEvent,
    nextAttemptAt: Date,
    errorMessage: string,
  ): Promise<void> {
    const result = await this.#orders.updateOne(claimFilter(claimed), {
      $inc: { 'outbox.publishAttempts': 1 },
      $set: {
        'outbox.lastError': errorMessage,
        'outbox.lockedAt': null,
        'outbox.lockToken': null,
        'outbox.nextAttemptAt': nextAttemptAt,
      },
    });
    requireMatchedClaim(result.matchedCount, claimed.event.eventId);
  }
}
