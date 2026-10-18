/**
 * The native API client against a fake server.
 *
 * What is asserted is the auth contract the server already enforces, seen from
 * the client: the refresh token is never handled here, CSRF travels only on
 * cookie-authenticated calls, a 401 costs exactly one shared refresh, and a
 * cold start that cannot reach the server stays `restoring` instead of
 * announcing that someone is signed out.
 */

import { describe, expect, it, vi } from 'vitest';

import { CSRF_HEADER, createApiClient, normaliseBaseUrl } from './client';
import { ApiError, toApiError } from './errors';
import { createSession, type CsrfStore } from './session';

const BASE = 'https://api.staging.dash.test';

interface Call {
  url: string;
  init: RequestInit;
}

function memoryStore(initial: string | null = null): CsrfStore & { value: string | null } {
  const store = {
    value: initial,
    get: async () => store.value,
    set: async (v: string | null) => {
      store.value = v;
    },
  };
  return store;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function harness(respond: (call: Call) => Response | Promise<Response>, csrf: string | null = null) {
  const calls: Call[] = [];
  const store = memoryStore(csrf);
  const session = createSession(store);
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  });
  const api = createApiClient({ baseUrl: BASE, fetch, session });
  return { api, session, store, calls, fetch };
}

const header = (call: Call | undefined, name: string): string | undefined =>
  (call?.init.headers as Record<string, string> | undefined)?.[name];

describe('restoring a session on a cold start', () => {
  it('knows at once that nobody is signed in when nothing is stored', async () => {
    const { api, fetch } = harness(() => json(500, {}));
    expect(await api.restore()).toBe('unauthenticated');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refreshes with the double-submit header and the cookie jar, never a token in the body', async () => {
    const { api, calls, store } = harness(() => json(200, { accessToken: 'access-2', csrfToken: 'csrf-2' }), 'csrf-1');
    expect(await api.restore()).toBe('authenticated');

    const refresh = calls[0];
    expect(refresh?.url).toBe(`${BASE}/v1/auth/refresh`);
    expect(refresh?.init.method).toBe('POST');
    expect(refresh?.init.credentials).toBe('include');
    expect(header(refresh, CSRF_HEADER)).toBe('csrf-1');
    expect(refresh?.init.body).toBeUndefined();
    // The rotated CSRF value is kept for the next cold start.
    expect(store.value).toBe('csrf-2');
  });

  it('signs out locally when the server refuses the session', async () => {
    const { api, store } = harness(() => json(401, { error: { code: 'unauthorized', message: 'Please sign in.' } }), 'csrf-1');
    expect(await api.restore()).toBe('unauthenticated');
    expect(store.value).toBeNull();
  });

  it('surfaces a retryable network error without throwing the stored session away', async () => {
    const { api, session, store } = harness(() => Promise.reject(new TypeError('Network request failed')), 'csrf-1');
    await expect(api.restore()).rejects.toMatchObject({ status: 0, code: 'network' });
    expect(session.state()).toBe('restoring');
    // Nothing thrown away: the session may be perfectly valid and can be
    // restored when the person taps Retry.
    expect(store.value).toBe('csrf-1');
  });
});

describe('an authenticated request', () => {
  it('sends the Bearer token and no CSRF header', async () => {
    const { api, session, calls } = harness(() => json(200, { ok: true }));
    await session.adopt({ accessToken: 'access-1', csrfToken: 'csrf-1' });
    await api.request('/v1/rider/offers');
    expect(header(calls[0], 'Authorization')).toBe('Bearer access-1');
    // The refresh cookie is path-scoped to /v1/auth, so an ordinary call has no
    // ambient credential to protect.
    expect(header(calls[0], CSRF_HEADER)).toBeUndefined();
  });

  it('refreshes once on a 401 and retries with the new token', async () => {
    let offers = 0;
    const { api, session, calls } = harness(({ url }) => {
      if (url.endsWith('/v1/auth/refresh')) return json(200, { accessToken: 'access-2', csrfToken: 'csrf-2' });
      offers += 1;
      return offers === 1 ? json(401, {}) : json(200, { offers: [] });
    });
    await session.adopt({ accessToken: 'access-1', csrfToken: 'csrf-1' });
    await expect(api.request('/v1/rider/offers')).resolves.toEqual({ offers: [] });
    expect(calls.map((c) => c.url.replace(BASE, ''))).toEqual(['/v1/rider/offers', '/v1/auth/refresh', '/v1/rider/offers']);
    expect(header(calls[2], 'Authorization')).toBe('Bearer access-2');
  });

  it('shares one refresh between requests that failed together', async () => {
    let refreshes = 0;
    const seen = new Map<string, number>();
    const { api, session } = harness(async ({ url }) => {
      if (url.endsWith('/v1/auth/refresh')) {
        refreshes += 1;
        await new Promise((r) => setTimeout(r, 5));
        return json(200, { accessToken: 'access-2', csrfToken: 'csrf-2' });
      }
      const n = (seen.get(url) ?? 0) + 1;
      seen.set(url, n);
      return n === 1 ? json(401, {}) : json(200, { url });
    });
    await session.adopt({ accessToken: 'access-1', csrfToken: 'csrf-1' });
    await Promise.all([api.request('/a'), api.request('/b'), api.request('/c')]);
    // Three refreshes would rotate the token three times and trip the
    // server's reuse detection.
    expect(refreshes).toBe(1);
  });

  it('takes a second 401 as the answer rather than looping', async () => {
    const { api, session, fetch } = harness(({ url }) =>
      url.endsWith('/v1/auth/refresh') ? json(200, { accessToken: 'access-2', csrfToken: 'csrf-2' }) : json(401, {}),
    );
    await session.adopt({ accessToken: 'access-1', csrfToken: 'csrf-1' });
    await expect(api.request('/v1/rider/offers')).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not attach a token to a public catalogue call', async () => {
    const { api, session, calls } = harness(() => json(200, { categories: [] }));
    await session.adopt({ accessToken: 'access-1' });
    await api.request('/v1/service-categories', { auth: false });
    expect(header(calls[0], 'Authorization')).toBeUndefined();
  });
});

describe('failures', () => {
  it('turns an unreachable server into a status-0 ApiError, not an unhandled rejection', async () => {
    const { api } = harness(() => Promise.reject(new TypeError('Network request failed')));
    await expect(api.request('/v1/service-categories', { auth: false })).rejects.toMatchObject({ status: 0, code: 'network' });
  });

  it('keeps the server\'s message and request reference', async () => {
    const error = await toApiError(
      json(409, { error: { code: 'offer_taken', message: 'Another rider accepted this order.', requestId: 'req-123' } }),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'offer_taken', message: 'Another rider accepted this order.', requestId: 'req-123' });
  });

  it('falls back to a human message when the body is not the envelope', async () => {
    const error = await toApiError(new Response('<html>502</html>', { status: 502, headers: { 'x-request-id': 'edge-9' } }));
    expect(error.message).toMatch(/trouble/);
    expect(error.requestId).toBe('edge-9');
  });

  it('refuses to guess a server when the build has none', async () => {
    const session = createSession(memoryStore());
    const api = createApiClient({ baseUrl: null, fetch: vi.fn(), session });
    expect(api.configured).toBe(false);
    await expect(api.request('/v1/service-categories')).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('signing out', () => {
  it.each([200, 401])('does not let an old refresh (%s) replace or clear a newer login', async (status) => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    const { api, session, calls } = harness(({ url }) => url.endsWith('/v1/auth/refresh') ? pending : json(401, {}));
    await session.adopt({ accessToken: 'old-access', csrfToken: 'old-csrf' });
    const request = api.request('/v1/orders').catch(() => undefined);
    await vi.waitFor(() => expect(calls.some((call) => call.url.endsWith('/v1/auth/refresh'))).toBe(true));
    await session.clear();
    await session.adopt({ accessToken: 'new-access', csrfToken: 'new-csrf' });
    finish(json(status, { accessToken: 'stale-access', csrfToken: 'stale-csrf' }));
    await request;
    expect(session.accessToken()).toBe('new-access');
    expect(session.csrfToken()).toBe('new-csrf');
    expect(session.state()).toBe('authenticated');
  });

  it('does not let a pending refresh sign the person back in after logout', async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    const { api, session, fetch } = harness(({ url }) => url.endsWith('/v1/auth/refresh') ? pending : json(200, {}), 'csrf-1');
    const restore = api.restore();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await api.signOut();
    finish(json(200, { accessToken: 'stale-access', csrfToken: 'stale-csrf' }));
    expect(await restore).toBe('unauthenticated');
    expect(session.accessToken()).toBeNull();
  });

  it('tells the server with the CSRF header, and clears locally even if the server is unreachable', async () => {
    const { api, session, store, calls } = harness(() => Promise.reject(new TypeError('offline')));
    await session.adopt({ accessToken: 'access-1', csrfToken: 'csrf-1' });
    await api.signOut();
    expect(header(calls[0], CSRF_HEADER)).toBe('csrf-1');
    expect(session.state()).toBe('unauthenticated');
    expect(session.accessToken()).toBeNull();
    expect(store.value).toBeNull();
  });
});

describe('the configured server', () => {
  it('accepts an http(s) origin and trims a trailing slash', () => {
    expect(normaliseBaseUrl('https://api.staging.dash.test/')).toBe('https://api.staging.dash.test');
    expect(normaliseBaseUrl('http://10.0.0.5:4000')).toBe('http://10.0.0.5:4000');
  });

  it('rejects anything that is not one', () => {
    for (const bad of [null, undefined, '', 'api.dash.test', 'ftp://x', 42]) expect(normaliseBaseUrl(bad), String(bad)).toBeNull();
  });
});
