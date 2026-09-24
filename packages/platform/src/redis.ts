import { createClient, type RedisClientType } from 'redis';

export interface CreateRedisClientOptions {
  readonly applicationName: string;
  readonly connectTimeoutMs?: number;
  readonly onError: (error: Error) => void;
  readonly url: string;
}

export interface RedisReadiness {
  readonly latencyMs: number;
}

interface ConnectableRedisClient {
  connect(): Promise<unknown>;
}

interface ClosableRedisClient {
  readonly isOpen: boolean;
  close(): Promise<unknown>;
}

interface PingableRedisClient {
  ping(): Promise<unknown>;
}

export function createRedisClient(options: CreateRedisClientOptions): RedisClientType {
  const client = createClient({
    url: options.url,
    name: options.applicationName,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: options.connectTimeoutMs ?? 5_000,
      reconnectStrategy: (retries) => Math.min(50 * 2 ** retries, 1_000),
    },
  });
  client.on('error', options.onError);
  return client;
}

export async function connectRedis<Client extends ConnectableRedisClient>(
  client: Client,
): Promise<Client> {
  await client.connect();
  return client;
}

export async function closeRedis(client: ClosableRedisClient): Promise<void> {
  if (client.isOpen) {
    await client.close();
  }
}

export async function checkRedisReadiness(client: PingableRedisClient): Promise<RedisReadiness> {
  const startedAt = performance.now();
  await client.ping();
  return { latencyMs: performance.now() - startedAt };
}
