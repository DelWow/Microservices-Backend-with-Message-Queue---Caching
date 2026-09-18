import { describe, expect, it } from 'vitest';

import {
  CreateOrderBodySchema,
  LoginRequestSchema,
  OrderParametersSchema,
} from '../services/order-service/src/index.js';

const VALID_ORDER_BODY = {
  currency: 'CAD',
  items: [{ productId: 'product-1', quantity: 2, unitPriceCents: 1_250 }],
};

describe('Order Service request schemas', () => {
  it('accepts the documented login and order requests', () => {
    expect(
      LoginRequestSchema.safeParse({ username: 'demo', password: 'demo-password' }).success,
    ).toBe(true);
    expect(CreateOrderBodySchema.safeParse(VALID_ORDER_BODY).success).toBe(true);
    expect(
      OrderParametersSchema.safeParse({
        orderId: 'a2dcadf0-888e-4d8c-bbfa-b01e95bc38b6',
      }).success,
    ).toBe(true);
  });

  it.each([
    ['missing password', { username: 'demo' }],
    ['empty username', { username: '', password: 'demo-password' }],
    ['unknown property', { username: 'demo', password: 'demo-password', role: 'admin' }],
  ])('rejects an invalid login request: %s', (_description, request) => {
    expect(LoginRequestSchema.safeParse(request).success).toBe(false);
  });

  it.each([
    ['lowercase currency', { ...VALID_ORDER_BODY, currency: 'cad' }],
    ['empty item list', { ...VALID_ORDER_BODY, items: [] }],
    [
      'fractional quantity',
      {
        ...VALID_ORDER_BODY,
        items: [{ productId: 'product-1', quantity: 1.5, unitPriceCents: 1_250 }],
      },
    ],
    [
      'zero quantity',
      {
        ...VALID_ORDER_BODY,
        items: [{ productId: 'product-1', quantity: 0, unitPriceCents: 1_250 }],
      },
    ],
    [
      'negative price',
      {
        ...VALID_ORDER_BODY,
        items: [{ productId: 'product-1', quantity: 1, unitPriceCents: -1 }],
      },
    ],
    ['unknown property', { ...VALID_ORDER_BODY, couponCode: 'UNSUPPORTED' }],
  ])('rejects an invalid create-order request: %s', (_description, request) => {
    expect(CreateOrderBodySchema.safeParse(request).success).toBe(false);
  });

  it.each([
    ['non-UUID', { orderId: 'not-a-uuid' }],
    ['missing ID', {}],
    [
      'unknown property',
      { orderId: 'a2dcadf0-888e-4d8c-bbfa-b01e95bc38b6', customerId: 'customer-1' },
    ],
  ])('rejects invalid order parameters: %s', (_description, parameters) => {
    expect(OrderParametersSchema.safeParse(parameters).success).toBe(false);
  });
});
