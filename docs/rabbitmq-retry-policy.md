# RabbitMQ Retry and Dead-Letter Policy

The versioned `order.created` topology uses durable exchanges and queues. The Order Service publishes persistent messages to `orders.events.v1` with the routing key `order.created.v1`. The Notification Service consumes from `notifications.order-created.v1` with manual acknowledgements.

## Retry sequence

Retryable delivery failures are bounded to three retries:

| Attempt |      Delay | Retry routing key          |
| ------- | ---------: | -------------------------- |
| 1       |   1 second | `order.created.retry.1.v1` |
| 2       |  5 seconds | `order.created.retry.2.v1` |
| 3       | 30 seconds | `order.created.retry.3.v1` |

The consumer increments an `x-retry-attempt` header, publishes the failed message persistently to `notifications.retry.v1`, waits for publisher confirmation, and only then acknowledges the original delivery. Each retry queue has a fixed message TTL and dead-letters expired messages back to `orders.events.v1` using `order.created.v1`.

After attempt three, the consumer publishes to `notifications.dead-letter.v1` with `order.created.failed.v1` and acknowledges the original only after confirmation. Invalid event envelopes and explicitly classified poison messages skip retries and go directly to the terminal queue `notifications.order-created.dlq.v1`.

The primary notification queue also dead-letters rejected messages to the terminal exchange as a safety net. The consumer must never use unbounded `nack(..., true)` requeue loops.

## Publishing consistency

Order creation stores its unpublished event in the order document atomically. A separate outbox publisher sends the event with RabbitMQ publisher confirms and marks it published only after confirmation. This preserves the event during broker outages while retaining at-least-once delivery; Notification Service idempotency remains required.
