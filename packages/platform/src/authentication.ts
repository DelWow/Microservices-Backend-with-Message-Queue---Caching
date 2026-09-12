import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import fastifyPlugin from 'fastify-plugin';

import { AuthenticationError, type AccessTokenClaims, type JwtService } from './jwt.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AccessTokenClaims | null;
  }

  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>;
  }
}

export interface BearerAuthenticationPluginOptions {
  readonly jwt: Pick<JwtService, 'verifyAccessToken'>;
}

export function parseBearerAuthorizationHeader(header: string | undefined): string {
  if (header === undefined) {
    throw new AuthenticationError('AUTHENTICATION_REQUIRED', 'A bearer token is required');
  }

  const match = /^Bearer ([^\s]+)$/iu.exec(header);

  if (match?.[1] === undefined) {
    throw new AuthenticationError(
      'AUTHENTICATION_INVALID',
      'The authorization header must use the Bearer scheme',
    );
  }

  return match[1];
}

export function requireAuthenticatedClaims(request: FastifyRequest): AccessTokenClaims {
  if (request.auth === null) {
    throw new AuthenticationError('AUTHENTICATION_REQUIRED', 'Authentication is required');
  }

  return request.auth;
}

const bearerAuthenticationPluginImplementation: FastifyPluginCallback<
  BearerAuthenticationPluginOptions
> = (fastify, options, done) => {
  fastify.decorateRequest('auth', null);
  fastify.decorate('authenticate', async (request: FastifyRequest): Promise<void> => {
    const token = parseBearerAuthorizationHeader(request.headers.authorization);
    request.auth = await options.jwt.verifyAccessToken(token);
  });
  done();
};

export const bearerAuthenticationPlugin = fastifyPlugin(bearerAuthenticationPluginImplementation, {
  fastify: '5.x',
  name: 'bearer-authentication',
});
