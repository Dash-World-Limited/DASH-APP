/**
 * Who is signed in, for every screen.
 *
 * On launch it restores the session from the OS cookie store (see
 * api/session.ts) without holding the splash screen: `restoring` is a real
 * state the screens draw, so a cold start never flashes "Sign in" at someone
 * who is signed in, and never waits on the network to show the app.
 *
 * A build with no server (no EXPO_PUBLIC_API_URL) is plainly signed out and
 * says why on the sign-in screen, rather than pretending.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { api, session, type SessionState } from '../api';
import { verifyRegistration } from './register';
import { loadViewer, requestSignInCode, verifySignInCode, type CodeSent, type Viewer } from './signIn';

interface AuthValue {
  state: SessionState;
  viewer: Viewer | null;
  /** False when this build is not pointed at a DASH server. */
  configured: boolean;
  requestCode: (email: string) => Promise<CodeSent>;
  /** Resolves once the session is adopted and the viewer loaded. Throws ApiError on refusal. */
  verifyCode: (email: string, code: string) => Promise<void>;
  /** Redeem a new account's email code; proving the address signs the person in. */
  completeRegistration: (email: string, code: string) => Promise<void>;
  /** Re-read /v1/auth/me after something the server changed (an application, an approval). */
  refreshViewer: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>(api.configured ? 'restoring' : 'unauthenticated');
  const [viewer, setViewer] = useState<Viewer | null>(null);

  useEffect(() => session.subscribe(setState), []);

  useEffect(() => {
    if (!api.configured) return;
    let live = true;
    api
      .restore()
      .then(async (restored) => {
        if (restored !== 'authenticated') return;
        const who = await loadViewer(api);
        if (live) setViewer(who);
      })
      .catch(() => undefined); // an unreachable server leaves `restoring`, by design
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (state === 'unauthenticated') setViewer(null);
  }, [state]);

  const requestCode = useCallback((email: string) => requestSignInCode(api, email), []);

  const verifyCode = useCallback(async (email: string, code: string) => {
    await verifySignInCode(api, session, email, code);
    setViewer(await loadViewer(api));
  }, []);

  const completeRegistration = useCallback(async (email: string, code: string) => {
    await verifyRegistration(api, session, email, code);
    setViewer(await loadViewer(api));
  }, []);

  const refreshViewer = useCallback(async () => {
    if (session.state() !== 'authenticated') return;
    setViewer(await loadViewer(api));
  }, []);

  const signOut = useCallback(() => api.signOut(), []);

  const value = useMemo(
    () => ({ state, viewer, configured: api.configured, requestCode, verifyCode, completeRegistration, refreshViewer, signOut }),
    [state, viewer, requestCode, verifyCode, completeRegistration, refreshViewer, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>.');
  return value;
}
