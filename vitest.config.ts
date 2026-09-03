import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The same `@/*` the web app's tsconfig maps. Web components import each
      // other through it, so without this a component test fails to resolve
      // imports the Next build resolves fine — a difference between the test
      // environment and the real one, which is exactly what a test must not have.
      '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
    },
  },
  // The web app is a Next project, which compiles JSX with the automatic
  // runtime — no `import React` at the top of every file. Vitest's own esbuild
  // defaults to the classic transform, so without this a component test fails
  // with "React is not defined" for a reason that has nothing to do with the
  // test.
  esbuild: { jsx: 'automatic' },
  test: {
    // `.tsx` as well as `.ts`: the web client's realtime integration is tested
    // through a real component, because "the UI never renders anything from a
    // notification" is a claim about rendering and cannot honestly be made
    // against a mock.
    include: ['packages/**/*.test.ts', 'apps/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    // Node everywhere. The one suite that needs a DOM opts in with a
    // `@vitest-environment jsdom` docblock rather than making every other file
    // pay for one.
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
