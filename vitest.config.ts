import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    environment: 'node',
    // Domain tests are pure and must never depend on the wall clock or on each
    // other. Any test that needs "now" injects a clock from @dash/domain/ports.
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['packages/domain/src/**/*.ts'],
      thresholds: {
        // The domain core is the part that must be right. Enforced, not aspirational.
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
