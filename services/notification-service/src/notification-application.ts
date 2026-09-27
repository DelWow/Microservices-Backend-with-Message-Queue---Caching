import { randomUUID } from 'node:crypto';

import type { OrderCreatedEvent } from '@microservices/contracts';

import type {
  RecordNotificationDeliveryInput,
  RecordNotificationDeliveryResult,
} from './notification-repository.js';

export interface NotificationDeliveryRepository {
  recordDelivery(input: RecordNotificationDeliveryInput): Promise<RecordNotificationDeliveryResult>;
}

export interface NotificationApplicationLogger {
  info(bindings: Readonly<Record<string, unknown>>, message: string): void;
}

export interface NotificationApplication {
  handleOrderCreated(event: OrderCreatedEvent): Promise<RecordNotificationDeliveryResult>;
}

export interface CreateNotificationApplicationOptions {
  readonly clock?: () => Date;
  readonly logger?: NotificationApplicationLogger;
  readonly notificationIdGenerator?: () => string;
  readonly repository: NotificationDeliveryRepository;
}

class DefaultNotificationApplication implements NotificationApplication {
  readonly #clock: () => Date;
  readonly #logger: NotificationApplicationLogger | undefined;
  readonly #notificationIdGenerator: () => string;
  readonly #repository: NotificationDeliveryRepository;

  public constructor(options: CreateNotificationApplicationOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#logger = options.logger;
    this.#notificationIdGenerator = options.notificationIdGenerator ?? randomUUID;
    this.#repository = options.repository;
  }

  public async handleOrderCreated(
    event: OrderCreatedEvent,
  ): Promise<RecordNotificationDeliveryResult> {
    const notificationId = this.#notificationIdGenerator();
    const result = await this.#repository.recordDelivery({
      notificationId,
      eventId: event.eventId,
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      orderId: event.payload.order.id,
      customerId: event.payload.order.customerId,
      channel: 'log',
      status: 'sent',
      message: `Order ${event.payload.order.id} was created`,
      processedAt: this.#clock(),
    });

    if (result === 'duplicate') {
      this.#logger?.info(
        {
          deliveryStatus: result,
          eventId: event.eventId,
          eventType: event.eventType,
          orderId: event.payload.order.id,
        },
        'Duplicate order event already processed',
      );
      return result;
    }

    this.#logger?.info(
      {
        deliveryStatus: result,
        eventId: event.eventId,
        eventType: event.eventType,
        notificationChannel: 'log',
        notificationId,
        orderId: event.payload.order.id,
      },
      'Order notification delivered',
    );
    return result;
  }
}

export function createNotificationApplication(
  options: CreateNotificationApplicationOptions,
): NotificationApplication {
  return new DefaultNotificationApplication(options);
}
