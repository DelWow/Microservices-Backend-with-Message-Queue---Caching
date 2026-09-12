import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  BooleanEnvironmentSchema,
  CommonEnvironmentSchema,
  EnvironmentValidationError,
  PortEnvironmentSchema,
  PositiveIntegerEnvironmentSchema,
  parseCommonEnvironment,
  parseEnvironment,
} from '../packages/platform/src/index.js';

describe('environment schemas', () => {
  it('applies safe common defaults', () => {
    expect(parseCommonEnvironment({})).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
    });
  });

  it('accepts configured common values while ignoring unrelated variables', () => {
    expect(
      parseCommonEnvironment({
        NODE_ENV: 'production',
        LOG_LEVEL: 'warn',
        UNRELATED: 'ignored',
      }),
    ).toEqual({
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
    });
  });

  it.each([
    ['true', true],
    ['false', false],
  ] as const)('parses the boolean string %s', (input, expected) => {
    expect(BooleanEnvironmentSchema.parse(input)).toBe(expected);
  });

  it('rejects ambiguous boolean strings', () => {
    expect(BooleanEnvironmentSchema.safeParse('1').success).toBe(false);
  });

  it('parses positive integers and valid TCP ports', () => {
    expect(PositiveIntegerEnvironmentSchema.parse('42')).toBe(42);
    expect(PortEnvironmentSchema.parse('65535')).toBe(65_535);
  });

  it.each(['0', '-1', '1.5', '65536'])('rejects invalid port %s', (port) => {
    expect(PortEnvironmentSchema.safeParse(port).success).toBe(false);
  });

  it('throws a sanitized error containing field paths but not secret values', () => {
    const schema = z.object({
      JWT_SECRET: z.string().min(32),
      PORT: PortEnvironmentSchema,
    });
    const secret = 'too-short';

    expect(() => parseEnvironment(schema, { JWT_SECRET: secret, PORT: 'invalid' })).toThrow(
      EnvironmentValidationError,
    );

    try {
      parseEnvironment(schema, { JWT_SECRET: secret, PORT: 'invalid' });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      expect((error as Error).message).toContain('JWT_SECRET');
      expect((error as Error).message).toContain('PORT');
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('exports the common schema for service-specific composition', () => {
    expect(
      CommonEnvironmentSchema.extend({ PORT: PortEnvironmentSchema }).parse({ PORT: '3000' }),
    ).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      PORT: 3_000,
    });
  });
});
