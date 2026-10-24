// @vitest-environment jsdom

/**
 * What a cold start shows before it knows who you are.
 *
 * A rider woken from a killed process by a push has a refresh token on disk
 * and a session about to come back. The old hook began life asserting "signed
 * out", so the screen rendered Sign In first — and on the handset the rider
 * typed their phone number into a form while, moments later, the refresh
 * succeeded and rotated into a new session. Nothing was broken except what
 * they were shown.
 *
 * These assert the three states directly. Sign In must appear only after a
 * restore has definitively failed, never merely because one has not finished.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const CSRF = 'dash_csrf';

function setCookie(present: boolean): void {
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => (present ? `${CSRF}=abc123; other=1` : 'other=1'),
    set: () => undefined,
  });
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

/**
 * Import fresh each time, and drive the refresh through `fetch`.
 *
 * Spying on the module's own export does not work here: `useSessionState`
 * calls `getAccessToken` as a module-local binding, so the spy is never
 * consulted and the real refresh runs. Mocking the transport is both closer to
 * reality and actually effective — the hook exercises the genuine refresh path
 * and only the network is a stand-in.
 */
async function loadHook(outcome: 'success' | 'failure' | 'pending') {
  vi.resetModules();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (outcome === 'pending') return new Promise<Response>(() => undefined);
      if (outcome === 'failure') {
        return new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ accessToken: 'token-abc', expiresIn: 900, csrfToken: 'c' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  return import('./session');
}

describe('useSessionState', () => {
  beforeEach(() => setCookie(true));

  it('starts in restoring when a session plausibly exists', async () => {
    // Never `unauthenticated` on the first frame. This is the whole bug: one
    // frame of "signed out" is a login form in front of a woken rider.
    const mod = await loadHook('pending');
    const { result } = renderHook(() => mod.useSessionState());
    expect(result.current).toBe('restoring');
  });

  it('never flashes Sign In when the restore succeeds', async () => {
    const mod = await loadHook('success');
    const seen: string[] = [];
    const { result } = renderHook(() => {
      const state = mod.useSessionState();
      seen.push(state);
      return state;
    });

    await waitFor(() => expect(result.current).toBe('authenticated'));
    // Every state on the way must have been restoring — no unauthenticated
    // frame at any point, which is what the rider actually sees.
    expect(seen).not.toContain('unauthenticated');
  });

  it('shows unauthenticated only once the restore has definitively failed', async () => {
    const mod = await loadHook('failure');
    const { result } = renderHook(() => mod.useSessionState());

    expect(result.current).toBe('restoring');
    await waitFor(() => expect(result.current).toBe('unauthenticated'));
  });

  it('checks the API before reporting a visitor without a readable cookie signed out', async () => {
    setCookie(false);
    const mod = await loadHook('failure');
    const { result } = renderHook(() => mod.useSessionState());
    expect(result.current).toBe('restoring');
    await waitFor(() => expect(result.current).toBe('unauthenticated'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports authenticated as a boolean only when genuinely restored', async () => {
    // `useHasSession` cannot express "not yet", so while restoring it must say
    // false — never true on the strength of an unredeemed cookie.
    const mod = await loadHook('pending');
    const { result } = renderHook(() => mod.useHasSession());
    expect(result.current).toBe(false);
  });
});
