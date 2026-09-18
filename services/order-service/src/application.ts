import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  LogController,
} from 'fastify';

export interface DemoCredentials {
  readonly username: string;
  readonly password: string;
}

export interface AccessTokenSigner {
  signAccessToken(input: {
    readonly subject: string;
    readonly username: string;
    readonly roles: readonly string[];
  }): Promise<string>;
}

export interface CreateOrderApplicationOptions {
  readonly accessTokenTtlSeconds: number;
  readonly demoCredentials: DemoCredentials;
  readonly jwt: AccessTokenSigner;
  readonly logger?: FastifyBaseLogger;
}

interface LoginBody {
  readonly username: string;
  readonly password: string;
}

type ErrorCode = 'VALIDATION_ERROR' | 'AUTHENTICATION_INVALID' | 'NOT_FOUND' | 'INTERNAL_ERROR';

class ApplicationError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApplicationError';
  }
}

const LOGIN_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['username', 'password'],
  properties: {
    username: { type: 'string', minLength: 1, maxLength: 128 },
    password: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;

function credentialDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function credentialsMatch(actual: LoginBody, expected: DemoCredentials): boolean {
  const usernameMatches = timingSafeEqual(
    credentialDigest(actual.username),
    credentialDigest(expected.username),
  );
  const passwordMatches = timingSafeEqual(
    credentialDigest(actual.password),
    credentialDigest(expected.password),
  );

  return usernameMatches && passwordMatches;
}

function errorResponse(code: ErrorCode, message: string, requestId: string): object {
  return {
    success: false,
    error: { code, message, requestId },
  };
}

function configureErrorHandling(application: FastifyInstance): void {
  application.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .send(errorResponse('NOT_FOUND', 'The requested resource was not found', request.id));
  });

  application.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApplicationError) {
      void reply.code(error.statusCode).send(errorResponse(error.code, error.message, request.id));
      return;
    }

    if (error.validation !== undefined) {
      void reply
        .code(400)
        .send(errorResponse('VALIDATION_ERROR', 'The request is invalid', request.id));
      return;
    }

    request.log.error({ err: error }, 'Unhandled request error');
    void reply
      .code(500)
      .send(errorResponse('INTERNAL_ERROR', 'An unexpected error occurred', request.id));
  });
}

export function createOrderApplication(options: CreateOrderApplicationOptions): FastifyInstance {
  const sharedOptions = {
    genReqId: () => randomUUID(),
    logController: new LogController({
      disableRequestLogging: false,
      requestIdLogLabel: 'requestId',
    }),
    requestIdHeader: 'x-request-id',
  } as const;
  const application =
    options.logger === undefined
      ? fastify({ ...sharedOptions, logger: false })
      : fastify({ ...sharedOptions, loggerInstance: options.logger });

  application.addHook('onRequest', (request, reply, done) => {
    void reply.header('x-request-id', request.id);
    done();
  });

  configureErrorHandling(application);

  application.post<{ Body: LoginBody }>(
    '/auth/login',
    { schema: { body: LOGIN_BODY_SCHEMA } },
    async (request) => {
      if (!credentialsMatch(request.body, options.demoCredentials)) {
        throw new ApplicationError(
          401,
          'AUTHENTICATION_INVALID',
          'The username or password is invalid',
        );
      }

      const accessToken = await options.jwt.signAccessToken({
        subject: `demo:${options.demoCredentials.username}`,
        username: options.demoCredentials.username,
        roles: ['customer'],
      });

      return {
        data: {
          accessToken,
          expiresIn: options.accessTokenTtlSeconds,
          tokenType: 'Bearer',
        },
      };
    },
  );

  return application;
}
