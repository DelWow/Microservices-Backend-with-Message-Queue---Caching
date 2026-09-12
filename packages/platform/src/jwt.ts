import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';

import { parseEnvironment } from './environment.js';

const JWT_ALGORITHM = 'HS256' as const;

export const JwtEnvironmentSchema = z.object({
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must contain at least 32 characters'),
  JWT_ISSUER: z.string().trim().min(1).max(256).default('microservices-backend'),
  JWT_AUDIENCE: z.string().trim().min(1).max(256).default('microservices-api'),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().max(86_400).default(900),
  JWT_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().min(0).max(300).default(5),
});

export const AccessTokenInputSchema = z
  .object({
    subject: z.string().trim().min(1).max(128),
    username: z.string().trim().min(1).max(128),
    roles: z.array(z.string().trim().min(1).max(64)).min(1).max(32),
  })
  .strict();

const AccessTokenPayloadSchema = z.object({
  sub: z.string().trim().min(1).max(128),
  username: z.string().trim().min(1).max(128),
  roles: z.array(z.string().trim().min(1).max(64)).min(1).max(32),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});

export interface JwtConfiguration {
  readonly secret: Uint8Array;
  readonly issuer: string;
  readonly audience: string;
  readonly ttlSeconds: number;
  readonly clockToleranceSeconds: number;
}

export interface AccessTokenInput {
  readonly subject: string;
  readonly username: string;
  readonly roles: readonly string[];
}

export interface AccessTokenClaims {
  readonly subject: string;
  readonly username: string;
  readonly roles: readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export type AuthenticationErrorCode = 'AUTHENTICATION_REQUIRED' | 'AUTHENTICATION_INVALID';

export class AuthenticationError extends Error {
  public readonly statusCode = 401;
  public readonly code: AuthenticationErrorCode;

  public constructor(code: AuthenticationErrorCode, message: string) {
    super(message);
    this.name = 'AuthenticationError';
    this.code = code;
  }
}

export interface JwtService {
  signAccessToken(input: AccessTokenInput): Promise<string>;
  verifyAccessToken(token: string): Promise<AccessTokenClaims>;
}

export interface JwtServiceDependencies {
  readonly clock?: () => Date;
}

export function parseJwtEnvironment(
  source: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> = process.env,
): JwtConfiguration {
  const environment = parseEnvironment(JwtEnvironmentSchema, source);

  return {
    secret: new TextEncoder().encode(environment.JWT_SECRET),
    issuer: environment.JWT_ISSUER,
    audience: environment.JWT_AUDIENCE,
    ttlSeconds: environment.JWT_TTL_SECONDS,
    clockToleranceSeconds: environment.JWT_CLOCK_TOLERANCE_SECONDS,
  };
}

export function createJwtService(
  configuration: JwtConfiguration,
  dependencies: JwtServiceDependencies = {},
): JwtService {
  const clock = dependencies.clock ?? (() => new Date());

  return {
    async signAccessToken(input): Promise<string> {
      const parsedInput = AccessTokenInputSchema.parse(input);
      const issuedAt = Math.floor(clock().getTime() / 1_000);

      return new SignJWT({
        username: parsedInput.username,
        roles: parsedInput.roles,
      })
        .setProtectedHeader({ alg: JWT_ALGORITHM, typ: 'JWT' })
        .setIssuer(configuration.issuer)
        .setAudience(configuration.audience)
        .setSubject(parsedInput.subject)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + configuration.ttlSeconds)
        .sign(configuration.secret);
    },

    async verifyAccessToken(token): Promise<AccessTokenClaims> {
      try {
        const { payload } = await jwtVerify(token, configuration.secret, {
          algorithms: [JWT_ALGORITHM],
          audience: configuration.audience,
          clockTolerance: configuration.clockToleranceSeconds,
          currentDate: clock(),
          issuer: configuration.issuer,
        });
        const claims = AccessTokenPayloadSchema.parse(payload);

        return {
          subject: claims.sub,
          username: claims.username,
          roles: claims.roles,
          issuedAt: claims.iat,
          expiresAt: claims.exp,
        };
      } catch {
        throw new AuthenticationError('AUTHENTICATION_INVALID', 'The bearer token is invalid');
      }
    },
  };
}
