/**
 * The native client's one door to the DASH API.
 *
 * Everything it needs is passed in — the base URL, `fetch`, the session — so
 * it runs the same in the app and under test, and nothing here reads a global.
 *
 * Rules it keeps, each of which the server also enforces:
 *
 * - The client never sends a price, fee, role or balance it computed. It asks.
 * - `credentials: 'include'` on every call, so the operating system's cookie
 *   store carries the HttpOnly refresh cookie to /v1/auth — and only there,
 *   because the server scopes that cookie's path. An ordinary Bearer request
 *   therefore carries no ambient credential and needs no CSRF header.
 * - The CSRF header goes on the cookie-authenticated calls: refresh and logout.
 * - One 401 on an authenticated call triggers one refresh, shared by every
 *   request that hit it at once, then one retry. A second 401 is an answer.
 * - A request that cannot reach the server is an `ApiError` with status 0,
 *   never an unhandled rejection and never a silent empty result.
 */

import { ApiError, networkError, notConfiguredError, toApiError } from './errors';
import type { Session, SessionState } from './session';

export const CSRF_HEADER = 'x-csrf-token';

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClientDeps {
  /** Null when the build is not pointed at a server. */
  baseUrl: string | null;
  fetch: FetchLike;
  session: Session;
  timeoutMs?: number;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Attach the Bearer token. Default true; public catalogue calls pass false. */
  auth?: boolean;
  signal?: AbortSignal;
  /**
   * Extra request headers. For `Idempotency-Key` on checkout, so a retried
   * tap can never place a second order. Cannot override Authorization.
   */
  headers?: Readonly<Record<string, string>>;
}

export interface ApiClient {
  readonly configured: boolean;
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  /** Cold-start restore. Resolves to the session state it settled on. */
  restore(): Promise<SessionState>;
  signOut(): Promise<void>;
}

/** Validate a configured base URL: http(s), no trailing slash. */
export function normaliseBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+/i.test(trimmed)) return null;
  return trimmed;
}

export function createApiClient({ baseUrl, fetch, session, timeoutMs = 15_000 }: ApiClientDeps): ApiClient {
  let refreshing: Promise<boolean> | null = null;

  const send = async (path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> => {
    if (!baseUrl) throw notConfiguredError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      return await fetch(`${baseUrl}${path}`, { ...init, credentials: 'include', signal: controller.signal });
    } catch {
      throw networkError();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };

  /** POST /v1/auth/refresh with the double-submit header. True if it worked. */
  const refresh = (): Promise<boolean> => {
    refreshing ??= (async () => {
      const csrf = session.csrfToken();
      if (!csrf) {
        await session.clear();
        return false;
      }
      try {
        const response = await send('/v1/auth/refresh', {
          method: 'POST',
          headers: { Accept: 'application/json', [CSRF_HEADER]: csrf },
        });
        if (response.status === 401 || response.status === 403) {
          // The server has refused the session — expired, revoked, or reused.
          await session.clear();
          return false;
        }
        if (!response.ok) throw await toApiError(response);
        const body = (await response.json()) as { accessToken?: unknown; csrfToken?: unknown };
        if (typeof body.accessToken !== 'string') throw new ApiError(502, 'bad_refresh', 'Could not restore your session.');
        await session.adopt({
          accessToken: body.accessToken,
          csrfToken: typeof body.csrfToken === 'string' ? body.csrfToken : null,
        });
        return true;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  };

  const request = async <T>(path: string, options: RequestOptions = {}, retried = false): Promise<T> => {
    const { method = 'GET', body, auth = true, signal } = options;
    const headers: Record<string, string> = { ...options.headers, Accept: 'application/json' };
    delete headers.Authorization;
    delete headers.authorization;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = auth ? session.accessToken() : null;
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await send(
      path,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      signal,
    );

    if (response.status === 401 && auth && !retried) {
      if (await refresh()) return request<T>(path, options, true);
    }
    if (!response.ok) throw await toApiError(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  };

  return {
    configured: baseUrl !== null,
    request,

    async restore() {
      const stored = await session.load();
      if (!stored) return session.state();
      try {
        await refresh();
      } catch (error) {
        // Could not reach the server. Preserve the stored CSRF/session hint,
        // but surface the network error so the native auth boundary can offer
        // an explicit retry instead of spinning forever or guessing "signed out".
        if (error instanceof ApiError && error.isNetwork) throw error;
        throw error;
      }
      return session.state();
    },

    async signOut() {
      const csrf = session.csrfToken();
      try {
        if (csrf) {
          await send('/v1/auth/logout', {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              [CSRF_HEADER]: csrf,
              ...(session.accessToken() ? { Authorization: `Bearer ${session.accessToken()}` } : {}),
            },
          });
        }
      } catch {
        // Signing out locally is still right when the server is unreachable.
      } finally {
        await session.clear();
      }
    },
  };
}
