import { z } from 'zod';

export const ORDER_STATUSES = ['pending', 'confirmed', 'cancelled'] as const;

export const OrderStatusSchema = z.enum(ORDER_STATUSES);

export const CurrencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/u, 'Currency must be a three-letter uppercase ISO 4217 code');

export const OrderItemSchema = z
  .object({
    productId: z.string().trim().min(1).max(128),
    quantity: z.number().int().min(1).max(1_000),
    unitPriceCents: z.number().int().min(0).max(100_000_000),
  })
  .strict();

export const CreateOrderRequestSchema = z
  .object({
    currency: CurrencyCodeSchema,
    items: z.array(OrderItemSchema).min(1).max(100),
  })
  .strict();

export const OrderSchema = z
  .object({
    id: z.uuid(),
    customerId: z.string().trim().min(1).max(128),
    status: OrderStatusSchema,
    currency: CurrencyCodeSchema,
    items: z.array(OrderItemSchema).min(1).max(100),
    totalCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((order, context) => {
    const calculatedTotal = order.items.reduce(
      (total, item) => total + item.quantity * item.unitPriceCents,
      0,
    );

    if (order.totalCents !== calculatedTotal) {
      context.addIssue({
        code: 'custom',
        message: 'totalCents must equal the sum of item quantity × unit price',
        path: ['totalCents'],
      });
    }
  });

export const OrderResponseSchema = z
  .object({
    data: OrderSchema,
  })
  .strict();

export type OrderStatus = z.infer<typeof OrderStatusSchema>;
export type OrderItem = z.infer<typeof OrderItemSchema>;
export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;
export type Order = z.infer<typeof OrderSchema>;
export type OrderResponse = z.infer<typeof OrderResponseSchema>;
