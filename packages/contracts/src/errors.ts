import { z } from 'zod';

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'AUTHENTICATION_REQUIRED',
  'AUTHENTICATION_INVALID',
  'NOT_FOUND',
  'CONFLICT',
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const ErrorResponseSchema = z
  .object({
    success: z.literal(false),
    error: z
      .object({
        code: ErrorCodeSchema,
        message: z.string().trim().min(1).max(1_000),
        requestId: z.string().trim().min(1).max(128),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
