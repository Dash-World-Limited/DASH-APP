// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real client/session/provider; only HTTP and device persistence are substituted.
// These are client contract tests, not evidence of live OTP or iOS cookie delivery.
const h = vi.hoisted(() => ({ csrf: null as string | null, fetch: vi.fn() }));
vi.mock('../../api', async () => {
  const { createApiClient } = await import('../../api/client');
  const { createSession } = await import('../../api/session');
  const { ApiError } = await import('../../api/errors');
  const session = createSession({ get: async () => h.csrf, set: async (value) => { h.csrf = value; } });
  return { session, ApiError, api: createApiClient({ baseUrl: 'https://staging.dash.test', fetch: (...args) => h.fetch(...args), session }) };
});
vi.mock('../push/pushRegistration', () => ({ forgetPushRegistration: async () => undefined }));

import { api, session } from '../../api';
import { AppSessionProvider, useAppSession, type Viewer } from './AppSessionProvider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const viewer: Viewer = {
  identity: { id: 'customer-fixture', phone: null, email: 'customer@example.test', displayName: 'Test Customer', locale: 'en' },
  roles: ['customer'], permissions: [], customerId: 'customer-fixture', riderId: null, riderStatus: null, riderAvailability: null,
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const tokens = () => json(200, { accessToken: 'access-fixture', csrfToken: 'csrf-fixture' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let auth: ReturnType<typeof useAppSession>;
let root: Root;
let container: HTMLDivElement;
function Probe() {
  auth = useAppSession();
  return <div>{auth.state}:{auth.viewer?.identity.displayName ?? 'no viewer'}:{auth.error ?? ''}</div>;
}
const settle = () => act(async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); });
async function mount() {
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(<AppSessionProvider><Probe /></AppSessionProvider>));
  await settle();
}
beforeEach(async () => {
  await session.clear();
  h.csrf = 'csrf-fixture';
  h.fetch.mockReset();
  h.fetch.mockImplementation(async (url: string) => url.endsWith('/v1/auth/refresh') ? tokens() : json(200, viewer));
});
afterEach(async () => { if (root) await act(async () => root.unmount()); });

describe('authenticated mobile session boundary', () => {
  it('keeps Customer/Rider screens gated until /me proves the restored identity', async () => {
    const me = deferred<Response>();
    h.fetch.mockImplementation(async (url: string) => url.endsWith('/v1/auth/refresh') ? tokens() : me.promise);
    await mount();
    expect(container.textContent).toBe('restoring:no viewer:');
    await act(async () => me.resolve(json(200, viewer)));
    expect(container.textContent).toBe('authenticated:Test Customer:');
  });

  it('offers restore retry when /me is offline, without admitting a null viewer', async () => {
    h.fetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/auth/refresh')) return tokens();
      throw new TypeError('Network request failed');
    });
    await mount();
    expect(auth.state).toBe('restoring');
    expect(auth.viewer).toBeNull();
    expect(auth.error).toBeTruthy();
    expect(h.csrf).toBe('csrf-fixture');
    h.fetch.mockImplementation(async (url: string) => url.endsWith('/v1/auth/refresh') ? tokens() : json(200, viewer));
    await act(async () => auth.restore());
    expect(container.textContent).toBe('authenticated:Test Customer:');
  });

  it('clears the viewer when an expired session is refused', async () => {
    await mount();
    expect(auth.viewer?.customerId).toBe('customer-fixture');
    h.fetch.mockResolvedValue(json(401, { error: { code: 'unauthorized', message: 'Please sign in.' } }));
    await act(async () => { await api.request('/v1/orders').catch(() => undefined); });
    expect(container.textContent).toBe('unauthenticated:no viewer:');
    expect(h.csrf).toBeNull();
  });

  it('resolves the approved Rider identity after OTP, before opening navigation', async () => {
    h.csrf = null;
    await mount();
    const me = deferred<Response>();
    h.fetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/otp/request')) return json(200, { sent: true });
      if (url.endsWith('/otp/verify')) return tokens();
      return me.promise;
    });
    await act(async () => { await auth.requestOtp({ email: 'rider@example.test' }); });
    let verified!: Promise<boolean>;
    await act(async () => { verified = auth.verifyOtp({ email: 'rider@example.test' }, '123456'); });
    expect(auth.state).not.toBe('authenticated');
    await act(async () => { me.resolve(json(200, { ...viewer, roles: ['customer', 'rider'], riderId: 'rider-fixture', riderStatus: 'approved' })); await verified; });
    expect(auth.state).toBe('authenticated');
    expect(auth.viewer?.riderStatus).toBe('approved');
  });

  it('does not resurrect a viewer if a pending restore completes after sign-out', async () => {
    const me = deferred<Response>();
    h.fetch.mockImplementation(async (url: string) => url.endsWith('/v1/auth/me') ? me.promise : tokens());
    await mount();
    await act(async () => auth.signOut());
    await act(async () => me.resolve(json(200, viewer)));
    expect(container.textContent).toBe('unauthenticated:no viewer:');
  });
});
