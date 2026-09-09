'use client';

/**
 * Client-side session handling.
 *
 * The access token is held in a module variable — memory only. It is never
 * written to `localStorage`, `sessionStorage`, or a cookie, so it dies with the
 * page and cannot be read back by a later script.
 *
 * The refresh token is not held here at all. It lives in a `HttpOnly` cookie
 * that this code cannot read even if it wanted to, and the browser attaches it
 * automatically to `/v1/auth/*`. That is the entire point: an XSS on this origin
 * can steal the 15-minute access token, but not the 30-day refresh token.
 *
 * The cost of cookies is CSRF, so every state-changing request echoes the CSRF
 * token from its (readable) cookie into a header. See apps/api/src/auth/cookies.ts.
 */

import { useEffect, useState } from 'react';
import { apiFetch, ApiRequestError, CSRF_COOKIE, type Me, type Session } from './api';

let accessToken: string | null = null;
let expiresAt = 0;
let refreshInFlight: Promise<string | null> | null = null;

/**
 * Whether this browser has ever been signed in during this page's life.
 *
 * The refresh cookie is HttpOnly, so there is no way to ask "am I signed in?"
 * without calling the server. This flag lets the app avoid a pointless refresh
 * on a cold load for a visitor who has never signed in, while still attempting
 * one for a returning user — the CSRF cookie, which IS readable, is the tell.
 */
function hasRefreshCookie(): boolean {
  if (typeof document === 'undefined') return false;
  return document.cookie.split('; ').some((entry) => entry.startsWith(`${CSRF_COOKIE}=`));
}

const listeners = new Set<() => void>();

function notify(): void {
  invalidateMe();
  for (const listener of listeners) listener();
}

export function subscribeToSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function storeAccess(session: Session): void {
  accessToken = session.accessToken;
  // Refresh 30s early so a request never races the expiry.
  expiresAt = Date.now() + (session.expiresIn - 30) * 1000;
  notify();
}

export function clearSession(): void {
  accessToken = null;
  expiresAt = 0;
  notify();
}

/**
 * True when a session plausibly exists.
 *
 * "Plausibly" is the honest word: the only local evidence is the CSRF cookie,
 * and the server is the authority. A stale cookie produces one failed refresh
 * and then a clean signed-out state.
 */
export function hasSession(): boolean {
  return accessToken !== null || hasRefreshCookie();
}

/**
 * Return a usable access token, refreshing if needed.
 *
 * Concurrent callers share one refresh. Without the `refreshInFlight` guard,
 * five parallel requests on a stale token would each rotate the refresh token,
 * and four of them would then be presenting an already-rotated one — which the
 * API correctly treats as theft and answers by revoking the whole session
 * family. The guard is not an optimisation; it prevents the client from
 * repeatedly logging itself out.
 */
export async function getAccessToken(): Promise<string | null> {
  if (accessToken && Date.now() < expiresAt) return accessToken;
  if (!hasRefreshCookie()) return null;

  refreshInFlight ??= (async () => {
    try {
      // No body. The refresh token rides in the HttpOnly cookie, and the CSRF
      // header is attached by `apiFetch`.
      const session = await apiFetch<Session>('/v1/auth/refresh', { method: 'POST' });
      storeAccess(session);
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
 * the permission hook, any page that gates on a role. Without this, each fires
 * its own `/v1/auth/me` and a single page load makes four identical requests.
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

/**
 * Whether a session exists, safe to call during render.
 *
 * Reading `document.cookie` during render would make the server render
 * "signed out" and the client render "signed in" — a hydration mismatch React
 * reports as an error and recovers from by discarding the server HTML. This
 * returns false until an effect has run.
 */
/**
 * Whether the app knows yet who the user is.
 *
 * Three states, because there genuinely are three. The old boolean collapsed
 * "we have not looked yet" into "signed out", and it began life as `false` — so
 * on every cold start a screen gated on it rendered Sign In for at least one
 * frame, before any refresh had been attempted.
 *
 * On a laptop that is an invisible flicker. On a handset woken from a killed
 * process by a push notification it is the whole experience: the rider taps a
 * notification about a delivery and lands on a login form. Device evidence
 * showed exactly that — the refresh token was on disk, the refresh *succeeded*
 * and rotated into a new session, and the rider had already typed their phone
 * number in by then. Nothing was broken except what they were shown.
 */
export type SessionState = 'restoring' | 'authenticated' | 'unauthenticated';

/**
 * Restore the session, and report which of the three states we are in.
 *
 * `restoring` is entered only when there is something to restore — the CSRF
 * cookie is readable and says a session plausibly exists — so a visitor who has
 * never signed in still goes straight to `unauthenticated` with no request and
 * no spinner.
 *
 * The refresh is *actively* driven here rather than waited for. Previously
 * nothing triggered one until a screen happened to make an API call, which on
 * a cold start is after it has already decided what to render.
 */
export function useSessionState(): SessionState {
  const [state, setState] = useState<SessionState>(() =>
    // Synchronous, so the first paint is already correct rather than a frame
    // of the wrong answer. `hasSession()` is a cookie read, not a request.
    hasSession() ? 'restoring' : 'unauthenticated',
  );

  useEffect(() => {
    let cancelled = false;

    const sync = (): void => {
      if (cancelled) return;
      // A token in hand is proof; anything else waits for the restore below.
      setState((current) =>
        accessToken !== null ? 'authenticated' : current === 'restoring' ? 'restoring' : current,
      );
    };

    void (async () => {
      if (!hasSession()) {
        if (!cancelled) setState('unauthenticated');
        return;
      }
      // The definitive answer: either a token comes back or the refresh has
      // genuinely failed. Sign In is rendered only on the second.
      const token = await getAccessToken();
      if (cancelled) return;
      setState(token ? 'authenticated' : 'unauthenticated');
    })();

    const unsubscribe = subscribeToSession(sync);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return state;
}

/**
 * Whether a session exists, as a boolean.
 *
 * Kept for the screens that only branch two ways, and deliberately reports
 * `false` while restoring — a caller that cannot express "not yet" must not be
 * told "yes" on the strength of a cookie that has not been redeemed. Screens
 * where the difference is visible to a user should use `useSessionState`.
 */
export function useHasSession(): boolean {
  return useSessionState() === 'authenticated';
}

/**
 * The signed-in actor, or null before it is known.
 *
 * Shares `loadMe`'s cache, so a page using both this and `usePermissions` still
 * makes one request. Screens need it for the ids their realtime topics are
 * built from — a vendor's own vendor, a rider's own rider, a dispatcher's own
 * cities — none of which the client may invent, and all of which the server
 * re-checks on every subscription anyway.
 */
export function useMe(): { me: Me | null; loaded: boolean } {
  const [me, setMe] = useState<Me | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const sync = async (): Promise<void> => {
      if (!hasSession()) {
        if (!cancelled) {
          setMe(null);
          setLoaded(true);
        }
        return;
      }
      const value = await loadMe();
      if (cancelled) return;
      setMe(value);
      setLoaded(true);
    };
    void sync();
    const unsubscribe = subscribeToSession(() => void sync());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return { me, loaded };
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

// ---------------------------------------------------------------------------
// Sign in / out
//
// None of these receive a refresh token. The API sets it as a cookie and the
// browser stores it; this code never sees the value.
// ---------------------------------------------------------------------------

/**
 * What a password sign-in produced.
 *
 * A discriminated union rather than a `Session`, because for a staff account
 * the password stage deliberately does **not** produce one. The API answers
 * `200 { mfaRequired: true, challengeToken }` with no access token at all, and
 * the previous code passed that straight to `storeAccess` — which set the token
 * to `undefined`, reported success, and redirected. The caller then looked
 * signed in, held nothing, and every request failed with "you do not have
 * access", blaming permissions for a missing second factor.
 *
 * Making the two outcomes different *types* is what stops that recurring: there
 * is no longer a shape a challenge and a session both satisfy, so a caller
 * cannot treat one as the other without the compiler objecting.
 */
export type PasswordSignInResult =
  | { kind: 'session'; session: Session }
  | {
      kind: 'mfa_required';
      /** `verify` means prove an existing authenticator; `enrol` means set one up. */
      stage: 'verify' | 'enrol';
      challengeToken: string;
      expiresAt: string;
    };

interface MfaChallengeResponse {
  mfaRequired?: boolean;
  stage?: 'verify' | 'enrol';
  challengeToken?: string;
  expiresAt?: string;
}

export async function signInWithPassword(
  email: string,
  password: string,
): Promise<PasswordSignInResult> {
  const response = await apiFetch<Session & MfaChallengeResponse>('/v1/auth/login', {
    method: 'POST',
    body: { email, password },
  });

  if (response.mfaRequired) {
    // Nothing is stored. The session begins after the second factor or not at
    // all — the whole point of requiring one.
    return {
      kind: 'mfa_required',
      stage: response.stage ?? 'verify',
      challengeToken: response.challengeToken ?? '',
      expiresAt: response.expiresAt ?? '',
    };
  }

  // Belt and braces: a response without a token is never a session, whatever
  // else it claims.
  if (!response.accessToken) {
    throw new ApiRequestError(0, 'unknown', 'Sign-in did not complete. Please try again.');
  }

  storeAccess(response);
  return { kind: 'session', session: response };
}

/**
 * Finish a staff sign-in with the authenticator code.
 *
 * The challenge token identifies the half-finished sign-in; the code proves
 * possession. Only on success does a session exist.
 */
export async function verifyMfa(challengeToken: string, code: string): Promise<Session> {
  const session = await apiFetch<Session>('/v1/auth/mfa/verify', {
    method: 'POST',
    body: { challengeToken, code },
  });
  if (!session.accessToken) {
    throw new ApiRequestError(0, 'unknown', 'That did not complete sign-in. Please try again.');
  }
  storeAccess(session);
  return session;
}

/**
 * Where a code should be sent: a phone number, or an email address.
 *
 * Exactly one, mirroring the API. The Declutters website signs people in by
 * email because that is the address they proved at signup; the app signs them
 * in by phone. One shape covers both, so neither grows its own sign-in client.
 */
export type OtpDestination = { phone: string } | { email: string };

export interface OtpRequestResult {
  sent: boolean;
  expiresInSeconds: number;
  message?: string;
  devCode?: string;
}

export async function requestOtp(destination: OtpDestination): Promise<OtpRequestResult> {
  return apiFetch('/v1/auth/otp/request', { method: 'POST', body: destination });
}

export async function verifyOtp(destination: OtpDestination, code: string): Promise<Session> {
  const session = await apiFetch<Session>('/v1/auth/otp/verify', {
    method: 'POST',
    body: { ...destination, code },
  });
  storeAccess(session);
  return session;
}

/**
 * Create an account.
 *
 * Returns the same shape whatever happened — created, already registered, or
 * refused because the phone number belongs to somebody else. The server
 * deliberately does not say which, and neither does this: the caller's next
 * step is the same in every case, which is to go and read their email.
 */
export interface SignUpInput {
  name: string;
  email: string;
  phone: string;
  state: string;
  cityArea: string;
  usageIntent: string;
  acquisitionSource: string;
  acquisitionDetail?: string;
  /** Both are required by the server; the form cannot submit without them. */
  confirmedAdult: true;
  acceptedTerms: true;
  /** Optional, always. Never a condition of holding a DASH account. */
  marketingOptIn: boolean;
}

export async function signUp(input: SignUpInput): Promise<OtpRequestResult> {
  return apiFetch('/v1/auth/signup', { method: 'POST', body: input });
}

export async function resendVerification(email: string): Promise<OtpRequestResult> {
  return apiFetch('/v1/auth/email/resend', { method: 'POST', body: { email } });
}

/** Redeem a verification code. Proving the address also signs the person in. */
export async function verifyEmail(email: string, code: string): Promise<Session> {
  const session = await apiFetch<Session>('/v1/auth/email/verify', {
    method: 'POST',
    body: { email, code },
  });
  storeAccess(session);
  return session;
}

export async function signOut(): Promise<void> {
  try {
    // The server clears both cookies; this cannot be done from script, because
    // the refresh cookie is HttpOnly.
    await authedFetch('/v1/auth/logout', { method: 'POST' });
  } catch {
    // Even if the call fails, drop the in-memory token — the user asked to
    // leave, and the cookie will expire on its own.
  } finally {
    clearSession();
  }
}
