import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    coverage: {
      exclude: ['**/*.d.ts', '**/dist/**', '**/node_modules/**', '**/test/**', '**/tests/**'],
      include: ['packages/*/src/**/*.ts', 'services/*/src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      thresholds: {
        branches: 75,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'services/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    mockReset: true,
    restoreMocks: true,
  },
});
