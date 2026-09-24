import { z } from 'zod';

import type { RepositoryOrder } from './order-repository.js';

const DEFAULT_CACHE_TTL_SECONDS = 60;
const CACHE_KEY_NAMESPACE = 'order-service:v1:orders';

const CachedOrderSchema = z
  .object({
    id: z.uuid(),
    customerId: z.string().min(1).max(128),
    status: z.enum(['pending', 'confirmed', 'cancelled']),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    items: z
      .array(
        z
          .object({
            productId: z.string().min(1).max(128),
            quantity: z.number().int().min(1).max(1_000),
            unitPriceCents: z.number().int().min(0).max(100_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    totalCents: z.number().int().nonnegative(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const OrderCacheEnvironmentSchema = z.object({
  CACHE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(86_400)
    .default(DEFAULT_CACHE_TTL_SECONDS),
});

export interface OrderCacheConfiguration {
  readonly enabled: boolean;
  readonly ttlSeconds: number;
}

export interface OrderCacheClient {
  del(key: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options: { readonly expiration: { readonly type: 'EX'; readonly value: number } },
  ): Promise<unknown>;
}

export type OrderCacheReadResult =
  | { readonly status: 'hit'; readonly order: RepositoryOrder }
  | { readonly status: 'miss' | 'bypass'; readonly order: null };

export function orderCacheKey(orderId: string): string {
  return `${CACHE_KEY_NAMESPACE}:${orderId}`;
}

export function parseOrderCacheConfiguration(
  source: Readonly<Record<string, string | undefined>> = process.env,
): OrderCacheConfiguration {
  const environment = OrderCacheEnvironmentSchema.parse(source);
  return {
    enabled: environment.CACHE_ENABLED,
    ttlSeconds: environment.CACHE_TTL_SECONDS,
  };
}

export class OrderCache {
  readonly #client: OrderCacheClient;
  readonly #configuration: OrderCacheConfiguration;

  public constructor(client: OrderCacheClient, configuration: OrderCacheConfiguration) {
    this.#client = client;
    this.#configuration = configuration;
  }

  public async get(orderId: string): Promise<OrderCacheReadResult> {
    if (!this.#configuration.enabled) {
      return { status: 'bypass', order: null };
    }

    const key = orderCacheKey(orderId);
    const value = await this.#client.get(key);

    if (value === null) {
      return { status: 'miss', order: null };
    }

    try {
      return { status: 'hit', order: CachedOrderSchema.parse(JSON.parse(value)) };
    } catch {
      await this.#client.del(key);
      return { status: 'miss', order: null };
    }
  }

  public async set(order: RepositoryOrder): Promise<void> {
    if (!this.#configuration.enabled) {
      return;
    }

    await this.#client.set(orderCacheKey(order.id), JSON.stringify(order), {
      expiration: { type: 'EX', value: this.#configuration.ttlSeconds },
    });
  }

  public async delete(orderId: string): Promise<void> {
    if (!this.#configuration.enabled) {
      return;
    }

    await this.#client.del(orderCacheKey(orderId));
  }
}
