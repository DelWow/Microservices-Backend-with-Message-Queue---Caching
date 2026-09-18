import { Writable } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../packages/platform/src/index.js';
import { createOrderApplication } from '../services/order-service/src/index.js';

const applications: FastifyInstance[] = [];

function buildApplication(
  overrides: {
    readonly logger?: ReturnType<typeof createLogger>;
    readonly signAccessToken?: () => Promise<string>;
  } = {},
): FastifyInstance {
  const application = createOrderApplication({
    accessTokenTtlSeconds: 900,
    demoCredentials: {
      username: 'demo',
      password: 'demo-password',
    },
    jwt: {
      signAccessToken: overrides.signAccessToken ?? vi.fn().mockResolvedValue('signed-token'),
    },
    ...(overrides.logger === undefined ? {} : { logger: overrides.logger }),
  });
  applications.push(application);
  return application;
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async (application) => application.close()));
});

describe('Order Service application', () => {
  it('returns a bearer token for the deterministic demo credentials', async () => {
    const signAccessToken = vi.fn().mockResolvedValue('signed-token');
    const application = buildApplication({ signAccessToken });

    const response = await application.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-request-id': 'login-request-1' },
      payload: { username: 'demo', password: 'demo-password' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('login-request-1');
    expect(response.json()).toEqual({
      data: {
        accessToken: 'signed-token',
        expiresIn: 900,
        tokenType: 'Bearer',
      },
    });
    expect(signAccessToken).toHaveBeenCalledWith({
      subject: 'demo:demo',
      username: 'demo',
      roles: ['customer'],
    });
  });

  it('rejects invalid credentials without revealing which value was wrong', async () => {
    const application = buildApplication();
    const response = await application.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-request-id': 'login-request-2' },
      payload: { username: 'demo', password: 'wrong-password' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      success: false,
      error: {
        code: 'AUTHENTICATION_INVALID',
        message: 'The username or password is invalid',
        requestId: 'login-request-2',
      },
    });
  });

  it('returns consistent validation, not-found, and internal error responses', async () => {
    const application = buildApplication({
      signAccessToken: vi.fn().mockRejectedValue(new Error('secret signing detail')),
    });

    const invalid = await application.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-request-id': 'validation-request' },
      payload: { username: 'demo' },
    });
    const missing = await application.inject({
      method: 'GET',
      url: '/missing',
      headers: { 'x-request-id': 'missing-request' },
    });
    const failed = await application.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-request-id': 'failed-request' },
      payload: { username: 'demo', password: 'demo-password' },
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request is invalid',
        requestId: 'validation-request',
      },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'The requested resource was not found',
        requestId: 'missing-request',
      },
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('secret signing detail');
  });

  it('emits structured request logs containing the request ID', async () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });
    const logger = createLogger(
      { serviceName: 'order-service', environment: 'test', level: 'info' },
      destination,
    );
    const application = buildApplication({ logger });

    const response = await application.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'demo', password: 'demo-password' },
    });
    const generatedRequestId = response.headers['x-request-id'];

    expect(generatedRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    const entries = lines.flatMap((line) =>
      line
        .trim()
        .split('\n')
        .filter((entry) => entry.length > 0)
        .map((entry) => JSON.parse(entry) as Record<string, unknown>),
    );
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestId: generatedRequestId, message: 'incoming request' }),
        expect.objectContaining({ requestId: generatedRequestId, message: 'request completed' }),
      ]),
    );
  });
});
