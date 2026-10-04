/**
 * Signing in with a code sent to your email: the rules, without React Native.
 *
 * The server already owns everything that matters (the code's generation,
 * hashing, expiry, single use, attempt ceiling and the per-address resend
 * limit; see apps/api/src/routes/auth.ts). This side only checks what is
 * typed before it is sent, words the answers for a person, and hands the
 * tokens to the session, which keeps the same model as the web: access token
 * in memory, refresh token only in the OS cookie store, CSRF value in secure
 * storage.
 *
 * Email, not phone: SMS delivery is off for V1. While Amazon SES is sandboxed
 * only verified addresses receive a code; the server answers the same either
 * way, so this screen never claims more than "if an account uses this
 * address, a code is on its way".
 *
 * Pure: tested directly.
 */

import type { ApiClient } from '../api/client';
import { ApiError } from '../api/errors';
import type { Session } from '../api/session';

export const CODE_LENGTH = 6;

/** Who is signed in, as `/v1/auth/me` describes them. Only what the app uses. */
export interface Viewer {
  identity: { id: string; email: string | null; phone: string | null; displayName: string | null };
  roles: string[];
  riderStatus: 'approved' | 'pending' | 'rejected' | 'suspended' | null;
  /** The server's record of the rider's shift, so the app resumes it after a restart. */
  riderAvailability?: 'offline' | 'idle' | 'on_delivery' | 'on_break' | null;
  /**
   * The server's statement about the phone number. `verification` is always
   * `unverified` in V1 — nothing proves a phone yet — and `notice` is the one
   * sentence to show beside it. Absent from an older server.
   */
  phone?: { number: string | null; verification: 'unverified'; required: boolean; notice: string | null };
}

export interface CodeSent {
  expiresInSeconds: number;
  /** When the server would send again. Account-independent, so safe to show. */
  resendAfterSeconds: number;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Null when the address can be sent; otherwise what to tell the person. */
export function emailProblem(raw: string): string | null {
  const value = normaliseEmail(raw);
  if (!value) return 'Enter your email address.';
  return EMAIL.test(value) ? null : 'Enter a valid email address, like ada@example.com.';
}

/** Keep only digits, at most six: pasted codes often carry spaces or a dash. */
export function codeDigits(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, CODE_LENGTH);
}

/** "ada@example.com" → "a•••@example.com": enough to recognise, not to read aloud. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = normaliseEmail(email).split('@');
  if (!domain) return email;
  return `${local.slice(0, 1)}•••@${domain}`;
}

/** "0:45" for a countdown. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export async function requestSignInCode(api: ApiClient, email: string): Promise<CodeSent> {
  const response = await api.request<{ expiresInSeconds?: unknown; resendAfterSeconds?: unknown }>(
    '/v1/auth/otp/request',
    { method: 'POST', auth: false, body: { email: normaliseEmail(email), purpose: 'login' } },
  );
  return {
    expiresInSeconds: typeof response.expiresInSeconds === 'number' ? response.expiresInSeconds : 300,
    resendAfterSeconds: typeof response.resendAfterSeconds === 'number' ? response.resendAfterSeconds : 60,
  };
}

/** Verify the code and adopt the session it mints. Throws ApiError on any refusal. */
export async function verifySignInCode(api: ApiClient, session: Session, email: string, code: string): Promise<void> {
  const tokens = await api.request<{ accessToken?: unknown; csrfToken?: unknown }>('/v1/auth/otp/verify', {
    method: 'POST',
    auth: false,
    body: { email: normaliseEmail(email), code: codeDigits(code), purpose: 'login' },
  });
  if (typeof tokens.accessToken !== 'string') {
    throw new ApiError(502, 'bad_sign_in', 'Could not finish signing you in. Please try again.');
  }
  await session.adopt({
    accessToken: tokens.accessToken,
    csrfToken: typeof tokens.csrfToken === 'string' ? tokens.csrfToken : null,
  });
}

export function loadViewer(api: ApiClient): Promise<Viewer> {
  return api.request<Viewer>('/v1/auth/me');
}

export type SignInErrorKind = 'not_configured' | 'network' | 'wrong_or_expired' | 'too_many' | 'other';

/**
 * What a failure means for the screen. The server's own message is kept (it
 * is written for a person); the kind decides what the screen offers next.
 */
export function classifySignInError(error: unknown): { kind: SignInErrorKind; message: string } {
  if (error instanceof ApiError) {
    if (error.code === 'not_configured') return { kind: 'not_configured', message: error.message };
    if (error.isNetwork) return { kind: 'network', message: error.message };
    if (error.status === 429) return { kind: 'too_many', message: error.message };
    if (error.status === 400) return { kind: 'wrong_or_expired', message: error.message };
    return { kind: 'other', message: error.message };
  }
  return { kind: 'other', message: 'Something went wrong. Please try again.' };
}

/** The name to greet someone by: display name, else the address, else nothing. */
export function viewerName(viewer: Viewer | null): string | null {
  if (!viewer) return null;
  return viewer.identity.displayName?.trim() || viewer.identity.email || viewer.identity.phone || null;
}
