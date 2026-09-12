import { z } from 'zod';

export const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const;
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export const BooleanEnvironmentSchema = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

export const PositiveIntegerEnvironmentSchema = z
  .string()
  .regex(/^\d+$/u, 'Expected a positive integer')
  .transform(Number)
  .pipe(z.number().int().positive());

export const PortEnvironmentSchema = PositiveIntegerEnvironmentSchema.pipe(
  z.number().int().min(1).max(65_535),
);

export const CommonEnvironmentSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVIRONMENTS).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export type NodeEnvironment = z.infer<typeof CommonEnvironmentSchema>['NODE_ENV'];
export type LogLevel = z.infer<typeof CommonEnvironmentSchema>['LOG_LEVEL'];
export type CommonEnvironment = z.infer<typeof CommonEnvironmentSchema>;

export class EnvironmentValidationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'EnvironmentValidationError';
    this.issues = issues;
  }
}

export function parseEnvironment<Schema extends z.ZodType>(
  schema: Schema,
  source: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> = process.env,
): z.output<Schema> {
  const result = schema.safeParse(source);

  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues.map((issue) => {
    const path = issue.path.length === 0 ? 'environment' : issue.path.join('.');
    return `${path}: ${issue.message}`;
  });

  throw new EnvironmentValidationError(issues);
}

export function parseCommonEnvironment(
  source: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> = process.env,
): CommonEnvironment {
  return parseEnvironment(CommonEnvironmentSchema, source);
}
