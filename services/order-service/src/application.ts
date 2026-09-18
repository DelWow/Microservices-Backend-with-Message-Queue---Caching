import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
  LogController,
} from 'fastify';

import type { OrderManagementService } from './order-service.js';

declare module 'fastify' {
  interface FastifyRequest {
    orderAuth: AccessTokenClaims | null;
  }
}

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

export interface AccessTokenClaims {
  readonly subject: string;
  readonly username: string;
  readonly roles: readonly string[];
}

export interface AccessTokenService extends AccessTokenSigner {
  verifyAccessToken(token: string): Promise<AccessTokenClaims>;
}

export interface CreateOrderApplicationOptions {
  readonly accessTokenTtlSeconds: number;
  readonly demoCredentials: DemoCredentials;
  readonly jwt: AccessTokenService;
  readonly logger?: FastifyBaseLogger;
  readonly orders: Pick<OrderManagementService, 'createOrder' | 'findOrder'>;
}

interface LoginBody {
  readonly username: string;
  readonly password: string;
}

interface CreateOrderBody {
  readonly currency: string;
  readonly items: readonly {
    readonly productId: string;
    readonly quantity: number;
    readonly unitPriceCents: number;
  }[];
}

interface OrderParameters {
  readonly orderId: string;
}

type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTHENTICATION_REQUIRED'
  | 'AUTHENTICATION_INVALID'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

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

const ORDER_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['productId', 'quantity', 'unitPriceCents'],
  properties: {
    productId: { type: 'string', minLength: 1, maxLength: 128 },
    quantity: { type: 'integer', minimum: 1, maximum: 1_000 },
    unitPriceCents: { type: 'integer', minimum: 0, maximum: 100_000_000 },
  },
} as const;

const CREATE_ORDER_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['currency', 'items'],
  properties: {
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    items: { type: 'array', minItems: 1, maxItems: 100, items: ORDER_ITEM_SCHEMA },
  },
} as const;

const ORDER_PARAMETERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['orderId'],
  properties: {
    orderId: {
      type: 'string',
      pattern:
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
    },
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

function bearerToken(authorization: string | undefined): string {
  if (authorization === undefined) {
    throw new ApplicationError(401, 'AUTHENTICATION_REQUIRED', 'A bearer token is required');
  }

  const match = /^Bearer ([^\s]+)$/iu.exec(authorization);

  if (match?.[1] === undefined) {
    throw new ApplicationError(
      401,
      'AUTHENTICATION_INVALID',
      'The authorization header must use the Bearer scheme',
    );
  }

  return match[1];
}

function authenticatedClaims(request: {
  readonly orderAuth: AccessTokenClaims | null;
}): AccessTokenClaims {
  if (request.orderAuth === null) {
    throw new ApplicationError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required');
  }

  return request.orderAuth;
}

function traceContext(): Readonly<Record<string, string>> {
  return {
    traceparent: `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`,
  };
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
  application.decorateRequest('orderAuth', null);

  configureErrorHandling(application);

  const authenticate = async (request: FastifyRequest): Promise<void> => {
    const token = bearerToken(request.headers.authorization);

    try {
      request.orderAuth = await options.jwt.verifyAccessToken(token);
    } catch {
      throw new ApplicationError(401, 'AUTHENTICATION_INVALID', 'The bearer token is invalid');
    }
  };

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

  application.post<{ Body: CreateOrderBody }>(
    '/orders',
    {
      preHandler: authenticate,
      schema: { body: CREATE_ORDER_BODY_SCHEMA },
    },
    async (request, reply) => {
      const claims = authenticatedClaims(request);
      const order = await options.orders.createOrder({
        customerId: claims.subject,
        currency: request.body.currency,
        items: request.body.items,
        correlationId: request.id,
        traceContext: traceContext(),
      });

      return reply.code(201).send({ data: order });
    },
  );

  application.get<{ Params: OrderParameters }>(
    '/orders/:orderId',
    {
      preHandler: authenticate,
      schema: { params: ORDER_PARAMETERS_SCHEMA },
    },
    async (request) => {
      const claims = authenticatedClaims(request);
      const order = await options.orders.findOrder(request.params.orderId, claims.subject);

      if (order === null) {
        throw new ApplicationError(404, 'NOT_FOUND', 'The requested order was not found');
      }

      return { data: order };
    },
  );

  return application;
}
