import { describe, expect, it, vi } from 'vitest';

import {
  checkRedisReadiness,
  closeRedis,
  connectRedis,
  createRedisClient,
} from '../packages/platform/src/index.js';

describe('Redis lifecycle helpers', () => {
  it('creates a disconnected client with an explicit error listener', () => {
    const onError = vi.fn();
    const client = createRedisClient({
      applicationName: 'redis-test',
      onError,
      url: 'redis://localhost:6379',
    });
    const error = new Error('connection failed');

    expect(client.isOpen).toBe(false);
    client.emit('error', error);
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('connects and gracefully closes an open client', async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const client = { connect, close, isOpen: true };

    await expect(connectRedis(client)).resolves.toBe(client);
    await closeRedis(client);

    expect(connect).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not close a client that was never opened', async () => {
    const close = vi.fn().mockResolvedValue(undefined);

    await closeRedis({ close, isOpen: false });

    expect(close).not.toHaveBeenCalled();
  });

  it('checks readiness with a Redis PING', async () => {
    const ping = vi.fn().mockResolvedValue('PONG');

    await expect(checkRedisReadiness({ ping })).resolves.toMatchObject({
      latencyMs: expect.any(Number) as number,
    });
    expect(ping).toHaveBeenCalledOnce();
  });
});
