/**
 * How the client obtains the CSRF token it has to echo.
 *
 * Same-origin, it reads the cookie and nothing else happens. Cross-subdomain it
 * cannot: the cookie is host-only to the API, so script on
 * `declutters.dashworldng.com` cannot see a cookie belonging to
 * `api.dashworldng.com`. The browser still sends it, so the API saw a cookie
 * and no header and answered `csrf_missing` — production, 2026-09-23 04:24:55.
 *
 * The recovery is deliberately **reactive**: the client asks the API for the
 * token only after a request has been refused for want of one. Fetching it
 * up front would add a round trip for every user on every deployment shape
 * that already worked, to fix the single case that is broken. The refusal it
 * responds to is free — CSRF is enforced in an `onRequest` hook, so a rejected
 * request never reached a handler and left nothing behind.
 *
 * These run in the node environment, where `document` is undefined, which is
 * what the client sees when the cookie is unreadable. The same-origin case
 * stubs `document.cookie` explicitly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_BASE, apiFetch, resetCsrfToken } from './api.js';

type FetchMock = ReturnType<typeof vi.fn>;

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The API's error envelope, so the client parses a real failure shape. */
function apiError(code: string, status: number): Response {
  return jsonResponse(
    { error: { code, message: 'Your session could not be verified.', requestId: 'req_test' } },
    status,
  );
}

function callsTo(fetchMock: FetchMock, path: string): unknown[][] {
  return fetchMock.mock.calls.filter((call) => String(call[0]).endsWith(path));
}

function headersOf(call: unknown[] | undefined): Record<string, string> {
  return ((call?.[1] as RequestInit | undefined)?.headers ?? {}) as Record<string, string>;
}

/**
 * An API that enforces CSRF: it refuses a write with no `X-CSRF-Token`, and
 * hands out `issued-token-N` from the bootstrap.
 */
function csrfEnforcingApi(): FetchMock {
  let issued = 0;

  return vi.fn(async (input: unknown, init?: RequestInit) => {
    if (String(input).endsWith('/v1/auth/csrf')) {
      issued += 1;
      return jsonResponse({ csrfToken: `issued-token-${issued}` });
    }

    const header = (init?.headers as Record<string, string> | undefined)?.['X-CSRF-Token'];
    if ((init?.method ?? 'GET') !== 'GET' && !header) return apiError('csrf_missing', 403);

    return jsonResponse({ ok: true });
  }) as unknown as FetchMock;
}

beforeEach(() => {
  resetCsrfToken();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as { document?: unknown }).document;
  resetCsrfToken();
});

describe('a returning browser that cannot read the cookie', () => {
  it('recovers: refused, bootstraps, retries, succeeds', async () => {
    const fetchMock = csrfEnforcingApi();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      apiFetch('/v1/auth/otp/request', { method: 'POST', body: { email: 'a@b.test' } }),
    ).resolves.toEqual({ ok: true });

    const writes = callsTo(fetchMock, '/v1/auth/otp/request');
    expect(writes).toHaveLength(2);

    // First attempt carried no token — that is the production failure.
    expect(headersOf(writes[0])['X-CSRF-Token']).toBeUndefined();
    // The retry carried the one the API handed back.
    expect(headersOf(writes[1])['X-CSRF-Token']).toBe('issued-token-1');

    expect(callsTo(fetchMock, '/v1/auth/csrf')).toHaveLength(1);
  });

  it('remembers the token, so only the first write pays for it', async () => {
    const fetchMock = csrfEnforcingApi();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await apiFetch('/v1/a', { method: 'POST', body: {} });
    await apiFetch('/v1/b', { method: 'POST', body: {} });
    await apiFetch('/v1/c', { method: 'POST', body: {} });

    // Bootstrapped once, not once per write.
    expect(callsTo(fetchMock, '/v1/auth/csrf')).toHaveLength(1);

    // And the later writes were accepted first time.
    expect(callsTo(fetchMock, '/v1/b')).toHaveLength(1);
    expect(headersOf(callsTo(fetchMock, '/v1/c')[0])['X-CSRF-Token']).toBe('issued-token-1');
  });

  it('sends credentials on the bootstrap, or the cookie would never be stored', async () => {
    const fetchMock = csrfEnforcingApi();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await apiFetch('/v1/auth/logout', { method: 'POST' });

    const bootstrap = callsTo(fetchMock, '/v1/auth/csrf')[0];
    expect(String(bootstrap?.[0])).toBe(`${API_BASE}/v1/auth/csrf`);
    expect((bootstrap?.[1] as RequestInit | undefined)?.credentials).toBe('include');
  });

  it('does not bootstrap for a read', async () => {
    const fetchMock = csrfEnforcingApi();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await apiFetch('/v1/declutter/taxonomy');

    expect(callsTo(fetchMock, '/v1/auth/csrf')).toHaveLength(0);
  });
});

describe('a fresh visitor, and same-origin development', () => {
  it('costs nothing extra when the API does not demand a token', async () => {
    // Incognito: no refresh cookie, so the API never enforces CSRF. This is
    // why the bug looked intermittent, and why the fix must not make this
    // path slower.
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true })) as unknown as FetchMock;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await apiFetch('/v1/auth/otp/request', { method: 'POST', body: { email: 'a@b.test' } });

    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(callsTo(fetchMock, '/v1/auth/csrf')).toHaveLength(0);
  });

  it('uses a readable cookie and never asks the API for one', async () => {
    (globalThis as { document?: unknown }).document = { cookie: 'dash_csrf=token-from-the-cookie' };

    const fetchMock = csrfEnforcingApi();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await apiFetch('/v1/auth/logout', { method: 'POST' });

    expect(callsTo(fetchMock, '/v1/auth/csrf')).toHaveLength(0);
    expect(headersOf(fetchMock.mock.calls[0])['X-CSRF-Token']).toBe('token-from-the-cookie');
  });
});

describe('a stale token', () => {
  it('is replaced and the request retried once', async () => {
    // A page open long enough for its token to expire, or a session rotated
    // underneath it. One quiet retry beats telling somebody their session
    // could not be verified over a recoverable state.
    let issued = 0;
    let writes = 0;

    const fetchMock = vi.fn(async (input: unknown) => {
      if (String(input).endsWith('/v1/auth/csrf')) {
        issued += 1;
        return jsonResponse({ csrfToken: `token-${issued}` });
      }
      writes += 1;
      return writes === 1 ? apiError('csrf_invalid', 403) : jsonResponse({ ok: true });
    }) as unknown as FetchMock;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(apiFetch('/v1/x', { method: 'POST', body: {} })).resolves.toEqual({ ok: true });

    expect(issued).toBe(1);
    expect(writes).toBe(2);
  });

  it('gives up after one retry rather than looping', async () => {
    let writes = 0;
    const fetchMock = vi.fn(async (input: unknown) => {
      if (String(input).endsWith('/v1/auth/csrf')) return jsonResponse({ csrfToken: 'a-token' });
      writes += 1;
      return apiError('csrf_invalid', 403);
    }) as unknown as FetchMock;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(apiFetch('/v1/x', { method: 'POST', body: {} })).rejects.toThrow();

    // Two attempts, never three. A persistent failure is a real problem and
    // retrying past it would only make it harder to find.
    expect(writes).toBe(2);
  });

  it('does not retry a failure that has nothing to do with CSRF', async () => {
    let writes = 0;
    const fetchMock = vi.fn(async (input: unknown) => {
      if (String(input).endsWith('/v1/auth/csrf')) return jsonResponse({ csrfToken: 'a-token' });
      writes += 1;
      return apiError('validation_failed', 422);
    }) as unknown as FetchMock;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(apiFetch('/v1/x', { method: 'POST', body: {} })).rejects.toThrow();
    expect(writes).toBe(1);
    expect(callsTo(fetchMock, '/v1/auth/csrf')).toHaveLength(0);
  });

  it('surfaces the original refusal when the bootstrap cannot be reached', async () => {
    // Offline mid-recovery. The user should see the real failure, not a
    // second one invented by the retry path.
    const fetchMock = vi.fn(async (input: unknown) => {
      if (String(input).endsWith('/v1/auth/csrf')) throw new Error('offline');
      return apiError('csrf_missing', 403);
    }) as unknown as FetchMock;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(apiFetch('/v1/x', { method: 'POST', body: {} })).rejects.toThrow(
      /session could not be verified/,
    );
  });
});
