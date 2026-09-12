import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AuthenticationError,
  bearerAuthenticationPlugin,
  createJwtService,
  parseBearerAuthorizationHeader,
  parseJwtEnvironment,
  requireAuthenticatedClaims,
  type JwtConfiguration,
  type JwtService,
} from '../packages/platform/src/index.js';

const SECRET = 'a-secure-test-secret-with-at-least-32-characters';
const START_TIME = new Date('2026-09-11T18:00:00.000Z');

function createConfiguration(overrides: Partial<JwtConfiguration> = {}): JwtConfiguration {
  return {
    secret: new TextEncoder().encode(SECRET),
    issuer: 'microservices-backend',
    audience: 'microservices-api',
    ttlSeconds: 900,
    clockToleranceSeconds: 0,
    ...overrides,
  };
}

async function signDemoToken(jwt: JwtService): Promise<string> {
  return jwt.signAccessToken({
    subject: 'user-123',
    username: 'demo',
    roles: ['customer'],
  });
}

async function createProtectedApplication(jwt: JwtService): Promise<FastifyInstance> {
  const application = fastify({ logger: false });
  await application.register(bearerAuthenticationPlugin, { jwt });

  application.get('/protected', { preHandler: application.authenticate }, (request) => {
    const claims = requireAuthenticatedClaims(request);
    return { subject: claims.subject, roles: claims.roles };
  });

  return application;
}

describe('JWT environment configuration', () => {
  it('parses validated JWT settings and defaults', () => {
    const configuration = parseJwtEnvironment({ JWT_SECRET: SECRET });

    expect(configuration).toMatchObject({
      issuer: 'microservices-backend',
      audience: 'microservices-api',
      ttlSeconds: 900,
      clockToleranceSeconds: 5,
    });
    expect(configuration.secret).toEqual(new TextEncoder().encode(SECRET));
  });

  it('rejects secrets shorter than 32 characters without exposing their value', () => {
    const secret = 'short-secret';

    expect(() => parseJwtEnvironment({ JWT_SECRET: secret })).toThrow('JWT_SECRET');

    try {
      parseJwtEnvironment({ JWT_SECRET: secret });
    } catch (error: unknown) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe('JWT service', () => {
  it('signs and verifies normalized access-token claims', async () => {
    const jwt = createJwtService(createConfiguration(), { clock: () => START_TIME });
    const token = await signDemoToken(jwt);

    await expect(jwt.verifyAccessToken(token)).resolves.toEqual({
      subject: 'user-123',
      username: 'demo',
      roles: ['customer'],
      issuedAt: 1_789_149_600,
      expiresAt: 1_789_150_500,
    });
  });

  it('rejects expired tokens outside clock tolerance', async () => {
    let now = START_TIME;
    const jwt = createJwtService(createConfiguration({ ttlSeconds: 1 }), { clock: () => now });
    const token = await signDemoToken(jwt);
    now = new Date(START_TIME.getTime() + 2_000);

    await expect(jwt.verifyAccessToken(token)).rejects.toMatchObject({
      code: 'AUTHENTICATION_INVALID',
      statusCode: 401,
    });
  });

  it('rejects tokens issued for another issuer', async () => {
    const signer = createJwtService(createConfiguration(), { clock: () => START_TIME });
    const verifier = createJwtService(createConfiguration({ issuer: 'another-issuer' }), {
      clock: () => START_TIME,
    });

    await expect(verifier.verifyAccessToken(await signDemoToken(signer))).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it('rejects tokens issued for another audience', async () => {
    const signer = createJwtService(createConfiguration(), { clock: () => START_TIME });
    const verifier = createJwtService(createConfiguration({ audience: 'another-api' }), {
      clock: () => START_TIME,
    });

    await expect(verifier.verifyAccessToken(await signDemoToken(signer))).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it('rejects a token with a modified signature', async () => {
    const jwt = createJwtService(createConfiguration(), { clock: () => START_TIME });
    const token = await signDemoToken(jwt);
    const [header, payload, signature, ...extraSegments] = token.split('.');

    if (
      header === undefined ||
      payload === undefined ||
      signature === undefined ||
      extraSegments.length !== 0
    ) {
      throw new Error('Expected a compact JWT');
    }

    const changedFirstCharacter = signature.startsWith('a') ? 'b' : 'a';
    const tamperedToken = `${header}.${payload}.${changedFirstCharacter}${signature.slice(1)}`;

    await expect(jwt.verifyAccessToken(tamperedToken)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('rejects invalid access-token input before signing', async () => {
    const jwt = createJwtService(createConfiguration(), { clock: () => START_TIME });

    await expect(
      jwt.signAccessToken({ subject: '', username: 'demo', roles: [] }),
    ).rejects.toBeDefined();
  });
});

describe('bearer authentication middleware', () => {
  const applications: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(applications.splice(0).map(async (application) => application.close()));
  });

  it('extracts a case-insensitive Bearer scheme', () => {
    expect(parseBearerAuthorizationHeader('bearer token-value')).toBe('token-value');
  });

  it.each([undefined, '', 'Basic abc', 'Bearer', 'Bearer token extra'])(
    'rejects a missing or malformed authorization header: %s',
    (header) => {
      expect(() => parseBearerAuthorizationHeader(header)).toThrow(AuthenticationError);
    },
  );

  it('attaches verified claims to protected requests', async () => {
    const jwt = createJwtService(createConfiguration(), { clock: () => START_TIME });
    const application = await createProtectedApplication(jwt);
    applications.push(application);
    const token = await signDemoToken(jwt);

    const response = await application.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ subject: 'user-123', roles: ['customer'] });
  });

  it('returns 401 when the bearer token is missing', async () => {
    const jwt = createJwtService(createConfiguration(), { clock: () => START_TIME });
    const application = await createProtectedApplication(jwt);
    applications.push(application);

    const response = await application.inject({ method: 'GET', url: '/protected' });

    expect(response.statusCode).toBe(401);
  });

  it('returns 401 when the bearer token is invalid', async () => {
    const jwt = createJwtService(createConfiguration(), { clock: () => START_TIME });
    const application = await createProtectedApplication(jwt);
    applications.push(application);

    const response = await application.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer invalid-token' },
    });

    expect(response.statusCode).toBe(401);
  });
});
