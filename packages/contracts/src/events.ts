import { z } from 'zod';

import { OrderSchema } from './order.js';

export const ORDER_CREATED_EVENT_TYPE = 'order.created' as const;
export const ORDER_CREATED_EVENT_VERSION = 1 as const;

const TRACEPARENT_PATTERN =
  /^(?!ff)[0-9a-f]{2}-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/u;

export const TraceContextSchema = z
  .object({
    traceparent: z.string().regex(TRACEPARENT_PATTERN, 'Invalid W3C traceparent header'),
    tracestate: z.string().min(1).max(512).optional(),
    baggage: z.string().min(1).max(8_192).optional(),
  })
  .strict();

export const OrderCreatedEventSchema = z
  .object({
    eventId: z.uuid(),
    eventType: z.literal(ORDER_CREATED_EVENT_TYPE),
    eventVersion: z.literal(ORDER_CREATED_EVENT_VERSION),
    occurredAt: z.iso.datetime({ offset: true }),
    correlationId: z.string().trim().min(1).max(128),
    traceContext: TraceContextSchema,
    payload: z
      .object({
        order: OrderSchema,
      })
      .strict(),
  })
  .strict();

export type TraceContext = z.infer<typeof TraceContextSchema>;
export type OrderCreatedEvent = z.infer<typeof OrderCreatedEventSchema>;
