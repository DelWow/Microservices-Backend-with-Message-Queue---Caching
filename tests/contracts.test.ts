import { describe, expect, it } from 'vitest';

import {
  CreateOrderRequestSchema,
  ErrorResponseSchema,
  ORDER_CREATED_EVENT_TYPE,
  ORDER_CREATED_EVENT_VERSION,
  OrderCreatedEventSchema,
  OrderSchema,
  TraceContextSchema,
} from '../packages/contracts/src/index.js';

const validOrder = {
  id: 'cfe700c6-4885-45e9-8c6b-c280911c626f',
  customerId: 'demo-customer',
  status: 'pending',
  currency: 'CAD',
  items: [
    { productId: 'coffee-beans', quantity: 2, unitPriceCents: 1_250 },
    { productId: 'delivery', quantity: 1, unitPriceCents: 500 },
  ],
  totalCents: 3_000,
  createdAt: '2026-09-11T18:00:00.000Z',
  updatedAt: '2026-09-11T18:00:00.000Z',
} as const;

const validTraceContext = {
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
};

const validEvent = {
  eventId: 'f62882a1-3ad3-4ce8-a658-bef44e96bec8',
  eventType: ORDER_CREATED_EVENT_TYPE,
  eventVersion: ORDER_CREATED_EVENT_VERSION,
  occurredAt: '2026-09-11T18:00:00.100Z',
  correlationId: 'request-123',
  traceContext: validTraceContext,
  payload: { order: validOrder },
} as const;

describe('order contracts', () => {
  it('accepts a valid order', () => {
    expect(OrderSchema.parse(validOrder)).toEqual(validOrder);
  });

  it('rejects an order whose total does not match its items', () => {
    const result = OrderSchema.safeParse({ ...validOrder, totalCents: 1 });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['totalCents']);
  });

  it('rejects an empty create-order request', () => {
    expect(CreateOrderRequestSchema.safeParse({ currency: 'CAD', items: [] }).success).toBe(false);
  });

  it('rejects unknown create-order fields', () => {
    const result = CreateOrderRequestSchema.safeParse({
      currency: 'CAD',
      items: [validOrder.items[0]],
      unexpected: true,
    });

    expect(result.success).toBe(false);
  });
});

describe('order.created event contract', () => {
  it('accepts a valid versioned event envelope', () => {
    expect(OrderCreatedEventSchema.parse(validEvent)).toEqual(validEvent);
  });

  it('rejects unsupported event versions', () => {
    expect(OrderCreatedEventSchema.safeParse({ ...validEvent, eventVersion: 2 }).success).toBe(
      false,
    );
  });

  it('rejects the wrong event type', () => {
    const result = OrderCreatedEventSchema.safeParse({
      ...validEvent,
      eventType: 'order.updated',
    });

    expect(result.success).toBe(false);
  });

  it('rejects an invalid W3C traceparent', () => {
    expect(TraceContextSchema.safeParse({ traceparent: 'not-a-traceparent' }).success).toBe(false);
  });
});

describe('error response contract', () => {
  it('accepts a structured error with safe details', () => {
    const response = {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request body is invalid',
        requestId: 'request-123',
        details: { field: 'items' },
      },
    } as const;

    expect(ErrorResponseSchema.parse(response)).toEqual(response);
  });

  it('rejects unrecognized error codes', () => {
    const result = ErrorResponseSchema.safeParse({
      success: false,
      error: {
        code: 'SOMETHING_UNDOCUMENTED',
        message: 'Unknown',
        requestId: 'request-123',
      },
    });

    expect(result.success).toBe(false);
  });
});
