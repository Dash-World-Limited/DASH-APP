/**
 * The signed-in session, as a native client holds it.
 *
 * The web client proved the model and this keeps every part of it:
 *
 *   access token  — held in memory only. Never written to storage.
 *   refresh token — never seen by this code at all. The server sets it as an
 *                   HttpOnly cookie scoped to /v1/auth; the operating system's
 *                   HTTP cookie store (OkHttp on Android, NSURLSession on iOS)
 *                   keeps it and sends it back. JavaScript cannot read it, the
 *                   same guarantee the browser gives.
 *   CSRF token    — the double-submit value. A browser reads it from a
 *                   readable cookie; React Native cannot read the native cookie
 *                   store, so the value the server also returns in the response
 *                   body is kept in the platform's secure storage and echoed in
 *                   `x-csrf-token`. It is not a credential on its own — it only
 *                   works alongside the cookie the attacker cannot reach.
 *
 * No backend change was needed for any of this.
 *
 * Three states, exactly as the web restore settled on after a device test:
 * `restoring` until the server has answered, so a cold start never flashes
 * "Sign in" at someone who is signed in.
 */

export type SessionState = 'restoring' | 'authenticated' | 'unauthenticated';

/** Where the CSRF value survives a restart. SecureStore in the app; a map in tests. */
export interface CsrfStore {
  get(): Promise<string | null>;
  set(value: string | null): Promise<void>;
}

export interface Session {
  state(): SessionState;
  accessToken(): string | null;
  csrfToken(): string | null;
  /** Load the persisted CSRF value. Resolves the state only if nothing is stored. */
  load(): Promise<string | null>;
  /** Tokens from a successful sign-in, verification or refresh. */
  adopt(tokens: { accessToken: string; csrfToken?: string | null }): Promise<void>;
  /** The server said no, or the person signed out. */
  clear(): Promise<void>;
  subscribe(listener: (state: SessionState) => void): () => void;
}

export function createSession(store: CsrfStore): Session {
  let state: SessionState = 'restoring';
  let access: string | null = null;
  let csrf: string | null = null;
  const listeners = new Set<(state: SessionState) => void>();

  const set = (next: SessionState): void => {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener(state);
  };

  return {
    state: () => state,
    accessToken: () => access,
    csrfToken: () => csrf,

    async load() {
      try {
        csrf = await store.get();
      } catch {
        csrf = null;
      }
      // Nothing stored means there was never a session on this device: that is
      // a definite answer, and waiting on the network for it would only delay
      // the sign-in screen.
      if (!csrf) set('unauthenticated');
      return csrf;
    },

    async adopt(tokens) {
      access = tokens.accessToken;
      if (tokens.csrfToken) {
        csrf = tokens.csrfToken;
        await store.set(csrf).catch(() => undefined);
      }
      set('authenticated');
    },

    async clear() {
      access = null;
      csrf = null;
      await store.set(null).catch(() => undefined);
      set('unauthenticated');
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
