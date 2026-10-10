// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://declutters.dashworldng.com/declutter/account"}
import { afterEach, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

it('restores after a full reload with invisible host-only API cookies, sharing refresh across callers', async () => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.dashworldng.com');
  Object.defineProperty(document, 'cookie', { configurable: true, get: () => '', set: () => undefined });
  let csrf = false;
  const transport = vi.fn(async (input: string, options: RequestInit) => {
    expect(options.credentials).toBe('include');
    if (input.endsWith('/csrf')) {
      csrf = true;
      expect(options.cache).toBe('no-store');
      return Response.json({ csrfToken: 'api-host-token' });
    }
    expect(input).toBe('https://api.dashworldng.com/v1/auth/refresh');
    if (!csrf) return Response.json({ error: { code: 'csrf_missing' } }, { status: 403 });
    expect(options.headers).toMatchObject({ 'X-CSRF-Token': 'api-host-token' });
    return Response.json({ accessToken: 'restored', expiresIn: 900 });
  });
  vi.stubGlobal('fetch', transport);
  const session = await import('./session');
  const seen: string[] = [];
  const hook = renderHook(() => { const state = session.useSessionState(); seen.push(state); return state; });
  const tokens = await Promise.all([session.getAccessToken(), session.getAccessToken()]);
  expect(tokens).toEqual(['restored', 'restored']);
  await waitFor(() => expect(hook.result.current).toBe('authenticated'));
  expect(seen).not.toContain('unauthenticated');
  expect(transport).toHaveBeenCalledTimes(3); // refused refresh, bootstrap, one successful refresh
  await session.getAccessToken();
  expect(transport).toHaveBeenCalledTimes(3);
  act(() => session.clearSession());
  expect(hook.result.current).toBe('unauthenticated');
  expect(await session.getAccessToken()).toBeNull();
  expect(transport).toHaveBeenCalledTimes(3);
});

it('an absent API refresh cookie settles signed out and does not repeatedly refresh', async () => {
  vi.resetModules();
  Object.defineProperty(document, 'cookie', { configurable: true, get: () => '', set: () => undefined });
  const transport = vi.fn(async () => Response.json({ error: { code: 'unauthorized' } }, { status: 401 }));
  vi.stubGlobal('fetch', transport);
  const session = await import('./session');
  expect(await session.getAccessToken()).toBeNull();
  expect(await session.getAccessToken()).toBeNull();
  expect(transport).toHaveBeenCalledTimes(1);
});
