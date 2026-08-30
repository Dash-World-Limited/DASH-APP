'use client';

/**
 * Client-side session handling.
 *
 * The access token is held in memory and the refresh token in `sessionStorage`.
 *
 * Neither goes in `localStorage`. `localStorage` persists indefinitely and is
 * readable by any script on the origin, so a single XSS gives an attacker a
 * token that outlives the browser session. `sessionStorage` at least dies with
 * the tab. The genuinely correct answer is an httpOnly cookie set by the API,
 * which is recorded as the production fix in docs/PROGRESS.md — it needs CSRF
 * protection and a same-site deployment, neither of which exists yet, and
 * pretending otherwise would be worse than being explicit about the trade.
 */

import { useEffect, useState } from 'react';
import { apiFetch, ApiRequestError, type Me, type Session } from './api';

const REFRESH_KEY = 'dash.refresh';

let accessToken: string | null = null;
let expiresAt = 0;
let refreshInFlight: Promise<string | null> | null = null;

const listeners = new Set<() => void>();

function notify(): void {
  // Any session change invalidates who we think is signed in, so the cached
  // identity is dropped before listeners re-read it.
  invalidateMe();
  for (const listener of listeners) listener();
}

export function subscribeToSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(REFRESH_KEY);
  } catch {
    // Private browsing or blocked storage. Treat as signed out rather than
    // crashing the app.
    return null;
  }
}

function writeRefreshToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (token === null) window.sessionStorage.removeItem(REFRESH_KEY);
    else window.sessionStorage.setItem(REFRESH_KEY, token);
  } catch {
    // Ignore — the in-memory access token still works for this page view.
  }
}

export function storeSession(session: Session): void {
  accessToken = session.accessToken;
  // Refresh 30s early so a request never races the expiry.
  expiresAt = Date.now() + (session.expiresIn - 30) * 1000;
  writeRefreshToken(session.refreshToken);
  notify();
}

export function clearSession(): void {
  accessToken = null;
  expiresAt = 0;
  writeRefreshToken(null);
  notify();
}

export function hasSession(): boolean {
  return accessToken !== null || readRefreshToken() !== null;
}

/**
 * Whether a session exists, safe to call during render.
 *
 * `hasSession()` reads `sessionStorage`, which does not exist on the server, so
 * calling it directly in a component body makes the server render "signed out"
 * and the client render "signed in" — a hydration mismatch that React reports
 * as an error and recovers from by throwing away the server HTML.
 *
 * This returns `false` on the server and on the first client render, then
 * updates in an effect. The brief "signed out" flash is the honest cost of not
 * knowing the answer until the browser has run.
 */
export function useHasSession(): boolean {
  const [value, setValue] = useState(false);

  useEffect(() => {
    const sync = (): void => setValue(hasSession());
    sync();
    return subscribeToSession(sync);
  }, []);

  return value;
}

/** The signed-in actor's permissions, or an empty set before they are known. */
export function usePermissions(): { permissions: Set<string>; loaded: boolean } {
  const [permissions, setPermissions] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const sync = async (): Promise<void> => {
      if (!hasSession()) {
        if (!cancelled) {
          setPermissions(new Set());
          setLoaded(true);
        }
        return;
      }
      const me = await loadMe();
      if (cancelled) return;
      setPermissions(new Set(me?.permissions ?? []));
      setLoaded(true);
    };
    void sync();
    const unsubscribe = subscribeToSession(() => void sync());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return { permissions, loaded };
}

/**
 * Return a usable access token, refreshing if needed.
 *
 * Concurrent callers share one refresh: without the `refreshInFlight` guard,
 * five parallel requests on a stale token would each rotate the refresh token,
 * and four of them would then be presenting an already-rotated token — which
 * the API correctly treats as theft and responds to by killing the session.
 */
export async function getAccessToken(): Promise<string | null> {
  if (accessToken && Date.now() < expiresAt) return accessToken;

  const refreshToken = readRefreshToken();
  if (!refreshToken) return null;

  refreshInFlight ??= (async () => {
    try {
      const session = await apiFetch<Session>('/v1/auth/refresh', {
        method: 'POST',
        body: { refreshToken },
      });
      storeSession(session);
      return session.accessToken;
    } catch {
      clearSession();
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/** Authenticated fetch: attaches a fresh token, retries once on a 401. */
export async function authedFetch<T>(
  path: string,
  options: Parameters<typeof apiFetch>[1] = {},
): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new ApiRequestError(401, 'unauthorized', 'Sign in to continue.');

  try {
    return await apiFetch<T>(path, { ...options, token });
  } catch (error) {
    if (error instanceof ApiRequestError && error.isAuthFailure) {
      // The token may have been revoked server-side. One retry with a fresh one.
      accessToken = null;
      const retryToken = await getAccessToken();
      if (retryToken) return apiFetch<T>(path, { ...options, token: retryToken });
      clearSession();
    }
    throw error;
  }
}

/**
 * The signed-in actor, cached and deduplicated.
 *
 * Several independent components want to know who is signed in — the header,
 * the permission hook, any page that gates on a role. Without this, each one
 * fires its own `/v1/auth/me`, and a single page load was making four identical
 * requests. They are cheap individually and pointless in aggregate.
 *
 * Concurrent callers share one in-flight request; subsequent callers get a
 * short-lived cache. The cache is cleared on any session change, so a sign-out
 * or a role change is never served stale.
 */
let meCache: { value: Me | null; at: number } | null = null;
let meInFlight: Promise<Me | null> | null = null;

const ME_CACHE_MS = 30_000;

export async function loadMe(): Promise<Me | null> {
  if (meCache && Date.now() - meCache.at < ME_CACHE_MS) return meCache.value;
  if (meInFlight) return meInFlight;

  meInFlight = (async () => {
    try {
      const me = await authedFetch<Me>('/v1/auth/me');
      meCache = { value: me, at: Date.now() };
      return me;
    } catch {
      meCache = { value: null, at: Date.now() };
      return null;
    } finally {
      meInFlight = null;
    }
  })();

  return meInFlight;
}

function invalidateMe(): void {
  meCache = null;
}

export async function signInWithPassword(email: string, password: string): Promise<Session> {
  const session = await apiFetch<Session>('/v1/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  storeSession(session);
  return session;
}

export async function requestOtp(
  phone: string,
): Promise<{ sent: boolean; expiresInSeconds: number; devCode?: string }> {
  return apiFetch('/v1/auth/otp/request', { method: 'POST', body: { phone } });
}

export async function verifyOtp(phone: string, code: string): Promise<Session> {
  const session = await apiFetch<Session>('/v1/auth/otp/verify', {
    method: 'POST',
    body: { phone, code },
  });
  storeSession(session);
  return session;
}

export async function signOut(): Promise<void> {
  try {
    await authedFetch('/v1/auth/logout', { method: 'POST' });
  } catch {
    // Even if the call fails, drop the local session — the user asked to leave.
  } finally {
    clearSession();
  }
}
