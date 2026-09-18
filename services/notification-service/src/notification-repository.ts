import {
  type Collection,
  type Db,
  type Document,
  type MongoClient,
  MongoServerError,
} from 'mongodb';

export interface RecordNotificationDeliveryInput {
  readonly notificationId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly orderId: string;
  readonly customerId: string;
  readonly channel: 'log';
  readonly status: 'sent' | 'failed';
  readonly message: string;
  readonly processedAt: Date;
}

export type RecordNotificationDeliveryResult = 'recorded' | 'duplicate';

interface ProcessedEventDocument extends Document {
  readonly _id: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly orderId: string;
  readonly processedAt: Date;
}

interface NotificationDocument extends Document {
  readonly _id: string;
  readonly eventId: string;
  readonly orderId: string;
  readonly customerId: string;
  readonly channel: 'log';
  readonly status: 'sent' | 'failed';
  readonly message: string;
  readonly createdAt: Date;
}

class DuplicateProcessedEventError extends Error {
  public constructor() {
    super('The event has already been processed');
    this.name = 'DuplicateProcessedEventError';
  }
}

export class MongoNotificationRepository {
  readonly #client: MongoClient;
  readonly #processedEvents: Collection<ProcessedEventDocument>;
  readonly #notifications: Collection<NotificationDocument>;

  public constructor(client: MongoClient, database: Db) {
    this.#client = client;
    this.#processedEvents = database.collection<ProcessedEventDocument>('processed_events');
    this.#notifications = database.collection<NotificationDocument>('notifications');
  }

  public async recordDelivery(
    input: RecordNotificationDeliveryInput,
  ): Promise<RecordNotificationDeliveryResult> {
    const session = this.#client.startSession();

    try {
      await session.withTransaction(
        async () => {
          try {
            await this.#processedEvents.insertOne(
              {
                _id: input.eventId,
                eventId: input.eventId,
                eventType: input.eventType,
                eventVersion: input.eventVersion,
                orderId: input.orderId,
                processedAt: input.processedAt,
              },
              { session },
            );
          } catch (error: unknown) {
            if (error instanceof MongoServerError && error.code === 11_000) {
              throw new DuplicateProcessedEventError();
            }

            throw error;
          }

          await this.#notifications.insertOne(
            {
              _id: input.notificationId,
              eventId: input.eventId,
              orderId: input.orderId,
              customerId: input.customerId,
              channel: input.channel,
              status: input.status,
              message: input.message,
              createdAt: input.processedAt,
            },
            { session },
          );
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        },
      );

      return 'recorded';
    } catch (error: unknown) {
      if (error instanceof DuplicateProcessedEventError) {
        return 'duplicate';
      }

      throw error;
    } finally {
      await session.endSession();
    }
  }
}
