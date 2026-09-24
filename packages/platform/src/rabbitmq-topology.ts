import type { Channel, Options, Replies } from 'amqplib';

export const ORDER_EVENTS_EXCHANGE = 'orders.events.v1';
export const ORDER_CREATED_ROUTING_KEY = 'order.created.v1';
export const NOTIFICATION_QUEUE = 'notifications.order-created.v1';
export const NOTIFICATION_RETRY_EXCHANGE = 'notifications.retry.v1';
export const NOTIFICATION_DEAD_LETTER_EXCHANGE = 'notifications.dead-letter.v1';
export const NOTIFICATION_DEAD_LETTER_QUEUE = 'notifications.order-created.dlq.v1';
export const NOTIFICATION_DEAD_LETTER_ROUTING_KEY = 'order.created.failed.v1';

export const NOTIFICATION_RETRY_STAGES = [
  {
    attempt: 1,
    delayMs: 1_000,
    queue: 'notifications.order-created.retry-1.v1',
    routingKey: 'order.created.retry.1.v1',
  },
  {
    attempt: 2,
    delayMs: 5_000,
    queue: 'notifications.order-created.retry-2.v1',
    routingKey: 'order.created.retry.2.v1',
  },
  {
    attempt: 3,
    delayMs: 30_000,
    queue: 'notifications.order-created.retry-3.v1',
    routingKey: 'order.created.retry.3.v1',
  },
] as const;

export interface RabbitMqTopologyChannel {
  assertExchange(
    exchange: string,
    type: string,
    options?: Options.AssertExchange,
  ): Promise<Replies.AssertExchange>;
  assertQueue(queue: string, options?: Options.AssertQueue): Promise<Replies.AssertQueue>;
  bindQueue(
    queue: string,
    source: string,
    pattern: string,
    arguments_?: unknown,
  ): Promise<Replies.Empty>;
}

const DURABLE_EXCHANGE_OPTIONS = { durable: true, autoDelete: false } as const;

export async function assertRabbitMqTopology(
  channel: RabbitMqTopologyChannel | Pick<Channel, 'assertExchange' | 'assertQueue' | 'bindQueue'>,
): Promise<void> {
  await channel.assertExchange(ORDER_EVENTS_EXCHANGE, 'topic', DURABLE_EXCHANGE_OPTIONS);
  await channel.assertExchange(NOTIFICATION_RETRY_EXCHANGE, 'direct', DURABLE_EXCHANGE_OPTIONS);
  await channel.assertExchange(
    NOTIFICATION_DEAD_LETTER_EXCHANGE,
    'direct',
    DURABLE_EXCHANGE_OPTIONS,
  );

  await channel.assertQueue(NOTIFICATION_QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': NOTIFICATION_DEAD_LETTER_EXCHANGE,
      'x-dead-letter-routing-key': NOTIFICATION_DEAD_LETTER_ROUTING_KEY,
    },
  });
  await channel.bindQueue(NOTIFICATION_QUEUE, ORDER_EVENTS_EXCHANGE, ORDER_CREATED_ROUTING_KEY);

  for (const stage of NOTIFICATION_RETRY_STAGES) {
    await channel.assertQueue(stage.queue, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': ORDER_EVENTS_EXCHANGE,
        'x-dead-letter-routing-key': ORDER_CREATED_ROUTING_KEY,
        'x-message-ttl': stage.delayMs,
      },
    });
    await channel.bindQueue(stage.queue, NOTIFICATION_RETRY_EXCHANGE, stage.routingKey);
  }

  await channel.assertQueue(NOTIFICATION_DEAD_LETTER_QUEUE, { durable: true });
  await channel.bindQueue(
    NOTIFICATION_DEAD_LETTER_QUEUE,
    NOTIFICATION_DEAD_LETTER_EXCHANGE,
    NOTIFICATION_DEAD_LETTER_ROUTING_KEY,
  );
}
