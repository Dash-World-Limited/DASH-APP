/**
 * Signing in by emailed code, against a fake server.
 *
 * Asserted: what is sent (a normalised address, digits only, never a token),
 * that a verified code becomes a session the same way the web's does (access
 * token in memory, CSRF value in the store, refresh token never touched), and
 * that each refusal is classified for the screen without inventing a message.
 */

import { describe, expect, it, vi } from 'vitest';

import { createApiClient } from '../api/client';
import { ApiError } from '../api/errors';
import { createSession, type CsrfStore } from '../api/session';
import {
  classifySignInError,
  codeDigits,
  emailProblem,
  formatCountdown,
  loadViewer,
  maskEmail,
  requestSignInCode,
  verifySignInCode,
  viewerName,
} from './signIn';

const BASE = 'https://api.staging.dash.test';
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function harness(respond: (url: string, init: RequestInit) => Response) {
  const stored: { value: string | null } = { value: null };
  const store: CsrfStore = { get: async () => stored.value, set: async (v) => void (stored.value = v) };
  const session = createSession(store);
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  });
  return { api: createApiClient({ baseUrl: BASE, fetch, session }), session, stored, calls };
}

const bodyOf = (init: RequestInit | undefined): Record<string, unknown> => JSON.parse(String(init?.body)) as Record<string, unknown>;

describe('what is typed', () => {
  it('asks for a real-looking address before anything is sent', () => {
    expect(emailProblem('')).toBe('Enter your email address.');
    expect(emailProblem('ada')).toMatch(/valid email/);
    expect(emailProblem('ada@example')).toMatch(/valid email/);
    expect(emailProblem('  Ada@Example.com ')).toBeNull();
  });

  it('keeps only the six digits of a pasted code', () => {
    expect(codeDigits('123 456')).toBe('123456');
    expect(codeDigits('12-34-56-78')).toBe('123456');
    expect(codeDigits('ab')).toBe('');
  });

  it('shows the address it went to without spelling it out', () => {
    expect(maskEmail('Ada@Example.com')).toBe('a•••@example.com');
    expect(formatCountdown(45)).toBe('0:45');
    expect(formatCountdown(61.2)).toBe('1:02');
    expect(formatCountdown(-3)).toBe('0:00');
  });
});

describe('requesting a code', () => {
  it('sends a normalised address, unauthenticated, and returns the server’s timings', async () => {
    const { api, calls } = harness(() => json(200, { sent: true, expiresInSeconds: 300, resendAfterSeconds: 60 }));
    expect(await requestSignInCode(api, '  Ada@Example.COM ')).toEqual({ expiresInSeconds: 300, resendAfterSeconds: 60 });
    expect(calls[0]?.url).toBe(`${BASE}/v1/auth/otp/request`);
    expect(bodyOf(calls[0]?.init)).toEqual({ email: 'ada@example.com', purpose: 'login' });
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('falls back to safe timings when an older server omits them', async () => {
    const { api } = harness(() => json(200, { sent: true }));
    expect(await requestSignInCode(api, 'ada@example.com')).toEqual({ expiresInSeconds: 300, resendAfterSeconds: 60 });
  });
});

describe('verifying the code', () => {
  it('adopts the session: access token in memory, CSRF value stored, no refresh token anywhere', async () => {
    const { api, session, stored, calls } = harness(() => json(200, { accessToken: 'access-1', csrfToken: 'csrf-1' }));
    await verifySignInCode(api, session, 'Ada@Example.com', '12 34 56');
    expect(bodyOf(calls[0]?.init)).toEqual({ email: 'ada@example.com', code: '123456', purpose: 'login' });
    expect(session.state()).toBe('authenticated');
    expect(session.accessToken()).toBe('access-1');
    expect(stored.value).toBe('csrf-1');
    expect(JSON.stringify(calls)).not.toContain('refreshToken');
  });

  it('refuses a response without an access token rather than half-signing in', async () => {
    const { api, session } = harness(() => json(200, { csrfToken: 'csrf-1' }));
    await expect(verifySignInCode(api, session, 'ada@example.com', '123456')).rejects.toBeInstanceOf(ApiError);
    expect(session.state()).not.toBe('authenticated');
  });

  it('loads the viewer with the new access token', async () => {
    const { api, session, calls } = harness((url) =>
      url.endsWith('/v1/auth/me')
        ? json(200, { identity: { id: 'i1', email: 'ada@example.com', phone: null, displayName: 'Ada Obi' }, roles: ['customer'], riderStatus: null })
        : json(200, { accessToken: 'access-1', csrfToken: 'csrf-1' }),
    );
    await verifySignInCode(api, session, 'ada@example.com', '123456');
    const viewer = await loadViewer(api);
    expect((calls[1]?.init.headers as Record<string, string>).Authorization).toBe('Bearer access-1');
    expect(viewerName(viewer)).toBe('Ada Obi');
  });
});

describe('when it does not work', () => {
  it('classifies each refusal and keeps the server’s own words', () => {
    expect(classifySignInError(new ApiError(400, 'bad_request', 'That code is not valid or has expired.'))).toEqual({
      kind: 'wrong_or_expired',
      message: 'That code is not valid or has expired.',
    });
    expect(classifySignInError(new ApiError(429, 'too_many_requests', 'Too many incorrect attempts. Request a new code.')).kind).toBe('too_many');
    expect(classifySignInError(new ApiError(0, 'network', 'Could not reach DASH.')).kind).toBe('network');
    expect(classifySignInError(new ApiError(0, 'not_configured', 'This build is not connected to a DASH server.')).kind).toBe('not_configured');
    expect(classifySignInError(new Error('boom'))).toEqual({ kind: 'other', message: 'Something went wrong. Please try again.' });
  });

  it('says so when the build has no server, without sending anything', async () => {
    const session = createSession({ get: async () => null, set: async () => undefined });
    const fetch = vi.fn();
    const api = createApiClient({ baseUrl: null, fetch, session });
    await expect(requestSignInCode(api, 'ada@example.com')).rejects.toMatchObject({ code: 'not_configured' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
