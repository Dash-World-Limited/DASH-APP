/**
 * Integration-shaped timeouts, applied per file.
 *
 * Vitest's defaults — 5s per test, 10s per hook — are unit-test defaults, and
 * they are the right ones for the 524 pure domain tests and the browser client
 * suites, all of which finish in single-digit milliseconds. They are the wrong
 * ones for the suites listed below, which build a Fastify instance, copy a
 * SQLite database, and drive real HTTP round trips against it.
 *
 * The evidence, measured on an idle machine:
 *
 *   - Suites that call `createTestContext` in a `beforeEach` spend 10–12
 *     seconds per test setting it up, against a 10s hook default. `key-rotation`
 *     failed on exactly that under load.
 *   - The heaviest test bodies measure 1.6–7.4 seconds sequentially, and run
 *     roughly three times slower under a full parallel run. `dispatch`'s
 *     "cannot be completed twice" measures 1.6s alone and crossed 5s in a
 *     contended run.
 *
 * `vi.setConfig` scopes this to the calling file, so it is applied only where
 * that evidence exists — ten of forty-three suites. Everything else keeps the
 * strict defaults, which is the point: a pure function that suddenly takes five
 * seconds should still fail.
 *
 * This relaxes no assertion and skips nothing. Every expectation still runs, and
 * a genuine hang still fails the suite — just later than it would have.
 *
 * The hook value matches the explicit `180_000` that thirteen suites already
 * pass to their own `beforeAll`, so the default no longer contradicts the
 * convention the codebase already had.
 */

import { vi } from 'vitest';

export function useIntegrationTimeouts(): void {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 180_000 });
}
