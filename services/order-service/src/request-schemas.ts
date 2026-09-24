import { z } from 'zod';

export const LoginRequestSchema = z
  .object({
    username: z.string().min(1).max(128),
    password: z.string().min(1).max(256),
  })
  .strict();

export const CreateOrderBodySchema = z
  .object({
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
  })
  .strict();

export const OrderParametersSchema = z
  .object({
    orderId: z.uuid(),
  })
  .strict();

export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type CreateOrderBody = z.infer<typeof CreateOrderBodySchema>;
export type OrderParameters = z.infer<typeof OrderParametersSchema>;
