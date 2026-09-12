import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  createLogger,
  getRequestContext,
  runWithRequestContext,
} from '../packages/platform/src/index.js';

function createLogCollector(): { readonly destination: Writable; readonly lines: string[] } {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) {
        callback(new TypeError('Expected the logger to write a string or Buffer'));
        return;
      }

      lines.push(chunk.toString());
      callback();
    },
  });

  return { destination, lines };
}

function parseLog(line: string | undefined): Record<string, unknown> {
  if (line === undefined) {
    throw new Error('Expected a structured log line');
  }

  return JSON.parse(line) as Record<string, unknown>;
}

describe('structured logger', () => {
  it('adds stable service metadata and request context', () => {
    const { destination, lines } = createLogCollector();
    const logger = createLogger(
      {
        serviceName: 'order-service',
        environment: 'test',
        level: 'info',
        version: '0.1.0',
      },
      destination,
    );

    runWithRequestContext({ requestId: 'request-123', correlationId: 'correlation-456' }, () => {
      logger.info({ orderId: 'order-789' }, 'order fetched');
    });

    expect(parseLog(lines[0])).toMatchObject({
      service: 'order-service',
      environment: 'test',
      version: '0.1.0',
      requestId: 'request-123',
      correlationId: 'correlation-456',
      orderId: 'order-789',
      message: 'order fetched',
    });
  });

  it('redacts credentials in common log locations', () => {
    const { destination, lines } = createLogCollector();
    const logger = createLogger(
      { serviceName: 'notification-service', environment: 'test', level: 'info' },
      destination,
    );

    logger.info(
      {
        password: 'plain-text-password',
        req: { headers: { authorization: 'Bearer token', cookie: 'session=value' } },
      },
      'credentials received',
    );

    expect(parseLog(lines[0])).toMatchObject({
      password: '[REDACTED]',
      req: {
        headers: {
          authorization: '[REDACTED]',
          cookie: '[REDACTED]',
        },
      },
    });
  });

  it('keeps request context scoped to its callback', () => {
    expect(getRequestContext()).toBeUndefined();

    runWithRequestContext({ requestId: 'request-1', correlationId: 'correlation-1' }, () => {
      expect(getRequestContext()).toEqual({
        requestId: 'request-1',
        correlationId: 'correlation-1',
      });
    });

    expect(getRequestContext()).toBeUndefined();
  });
});
