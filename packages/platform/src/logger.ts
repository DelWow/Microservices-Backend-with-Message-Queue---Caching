import { AsyncLocalStorage } from 'node:async_hooks';

import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

import type { LogLevel, NodeEnvironment } from './environment.js';

export interface RequestContext {
  readonly requestId: string;
  readonly correlationId: string;
}

export interface CreateLoggerOptions {
  readonly serviceName: string;
  readonly environment: NodeEnvironment;
  readonly level: LogLevel;
  readonly version?: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

const REDACTED_LOG_PATHS = [
  'password',
  '*.password',
  'authorization',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'JWT_SECRET',
  'jwtSecret',
] as const;

export function createLogger(
  options: CreateLoggerOptions,
  destination?: DestinationStream,
): Logger {
  const base: Record<string, string> = {
    environment: options.environment,
    service: options.serviceName,
  };

  if (options.version !== undefined) {
    base.version = options.version;
  }

  const loggerOptions: LoggerOptions = {
    base,
    level: options.level,
    messageKey: 'message',
    mixin: () => requestContextStorage.getStore() ?? {},
    redact: {
      censor: '[REDACTED]',
      paths: [...REDACTED_LOG_PATHS],
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  return pino(loggerOptions, destination);
}

export function runWithRequestContext<Result>(
  context: RequestContext,
  callback: () => Result,
): Result {
  return requestContextStorage.run({ ...context }, callback);
}

export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}
