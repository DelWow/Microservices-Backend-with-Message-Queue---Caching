import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import {
  createOrderApplication,
  type AccessTokenService,
  type CreateOrderCommand,
  type RepositoryOrder,
} from '../services/order-service/src/index.js';

const ORDER_ID = 'a2dcadf0-888e-4d8c-bbfa-b01e95bc38b6';
const ORDER: RepositoryOrder = {
  id: ORDER_ID,
  customerId: 'customer-1',
  status: 'pending',
  currency: 'CAD',
  items: [{ productId: 'product-1', quantity: 2, unitPriceCents: 1_250 }],
  totalCents: 2_500,
  createdAt: '2026-09-18T12:00:00.000Z',
  updatedAt: '2026-09-18T12:00:00.000Z',
};
const applications: FastifyInstance[] = [];

interface TokenFixture {
  readonly service: AccessTokenService;
  readonly verifyAccessToken: Mock<AccessTokenService['verifyAccessToken']>;
}

interface ApplicationFixture {
  readonly application: FastifyInstance;
  readonly createOrder: Mock<(command: CreateOrderCommand) => Promise<RepositoryOrder>>;
  readonly findOrder: Mock<
    (orderId: string, customerId: string) => Promise<RepositoryOrder | null>
  >;
  readonly verifyAccessToken: Mock<AccessTokenService['verifyAccessToken']>;
}

function createTokenFixture(): TokenFixture {
  const verifyAccessToken = vi.fn<AccessTokenService['verifyAccessToken']>().mockResolvedValue({
    subject: 'customer-1',
    username: 'demo',
    roles: ['customer'],
  });
  return {
    service: {
      signAccessToken: vi.fn().mockResolvedValue('signed-token'),
      verifyAccessToken,
    },
    verifyAccessToken,
  };
}

function buildApplication(
  options: {
    readonly createOrder?: Mock<(command: CreateOrderCommand) => Promise<RepositoryOrder>>;
    readonly findOrder?: Mock<
      (orderId: string, customerId: string) => Promise<RepositoryOrder | null>
    >;
    readonly tokenFixture?: TokenFixture;
  } = {},
): ApplicationFixture {
  const tokenFixture = options.tokenFixture ?? createTokenFixture();
  const createOrder = options.createOrder ?? vi.fn().mockResolvedValue(ORDER);
  const findOrder = options.findOrder ?? vi.fn().mockResolvedValue(ORDER);
  const application = createOrderApplication({
    accessTokenTtlSeconds: 900,
    demoCredentials: { username: 'demo', password: 'demo-password' },
    jwt: tokenFixture.service,
    orders: { createOrder, findOrder },
  });
  applications.push(application);
  return {
    application,
    createOrder,
    findOrder,
    verifyAccessToken: tokenFixture.verifyAccessToken,
  };
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async (application) => application.close()));
});

describe('Order Service order API', () => {
  it('authenticates and creates a validated order', async () => {
    const { application, createOrder, verifyAccessToken } = buildApplication();
    const response = await application.inject({
      method: 'POST',
      url: '/orders',
      headers: {
        authorization: 'Bearer valid-token',
        'x-request-id': 'create-request',
      },
      payload: {
        currency: 'CAD',
        items: [{ productId: 'product-1', quantity: 2, unitPriceCents: 1_250 }],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ data: ORDER });
    expect(verifyAccessToken).toHaveBeenCalledWith('valid-token');
    expect(createOrder).toHaveBeenCalledOnce();
    const command = createOrder.mock.calls[0]?.[0];
    expect(command).toMatchObject({
      customerId: 'customer-1',
      currency: 'CAD',
      items: [{ productId: 'product-1', quantity: 2, unitPriceCents: 1_250 }],
      correlationId: 'create-request',
    });
    expect(command?.traceContext.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u);
  });

  it('rejects missing authentication and invalid create-order bodies', async () => {
    const { application, createOrder } = buildApplication();
    const unauthenticated = await application.inject({
      method: 'POST',
      url: '/orders',
      payload: {
        currency: 'CAD',
        items: [{ productId: 'product-1', quantity: 1, unitPriceCents: 100 }],
      },
    });
    const invalid = await application.inject({
      method: 'POST',
      url: '/orders',
      headers: { authorization: 'Bearer valid-token' },
      payload: {
        currency: 'cad',
        items: [{ productId: 'product-1', quantity: 0, unitPriceCents: 100 }],
      },
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({
      success: false,
      error: { code: 'AUTHENTICATION_REQUIRED' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR' },
    });
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('returns an authenticated order and validates its ID', async () => {
    const { application, findOrder } = buildApplication();
    const found = await application.inject({
      method: 'GET',
      url: `/orders/${ORDER_ID}`,
      headers: { authorization: 'Bearer valid-token' },
    });
    const invalid = await application.inject({
      method: 'GET',
      url: '/orders/not-a-uuid',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(found.statusCode).toBe(200);
    expect(found.json()).toEqual({ data: ORDER });
    expect(findOrder).toHaveBeenCalledWith(ORDER_ID, 'customer-1');
    expect(invalid.statusCode).toBe(400);
  });

  it('returns a scoped not-found response and rejects an invalid token', async () => {
    const tokenFixture = createTokenFixture();
    tokenFixture.verifyAccessToken.mockRejectedValue(new Error('invalid signature'));
    const invalidTokenApplication = buildApplication({ tokenFixture }).application;
    const notFoundApplication = buildApplication({
      findOrder: vi.fn().mockResolvedValue(null),
    }).application;

    const invalidToken = await invalidTokenApplication.inject({
      method: 'GET',
      url: `/orders/${ORDER_ID}`,
      headers: { authorization: 'Bearer invalid-token' },
    });
    const missing = await notFoundApplication.inject({
      method: 'GET',
      url: `/orders/${ORDER_ID}`,
      headers: { authorization: 'Bearer valid-token', 'x-request-id': 'fetch-request' },
    });

    expect(invalidToken.statusCode).toBe(401);
    expect(invalidToken.body).not.toContain('invalid signature');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'The requested order was not found',
        requestId: 'fetch-request',
      },
    });
  });
});
