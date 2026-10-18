import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { api, ApiError, session, type SessionState } from '../../api';
import { forgetPushRegistration } from '../push/pushRegistration';

export interface Viewer {
  identity: {
    id: string;
    phone: string | null;
    email: string | null;
    displayName: string | null;
    locale: string;
  };
  roles: string[];
  permissions: string[];
  customerId: string | null;
  riderId: string | null;
  riderStatus: string | null;
  riderAvailability: string | null;
}

interface OtpDestination {
  phone?: string;
  email?: string;
}

interface SessionValue {
  configured: boolean;
  state: SessionState;
  viewer: Viewer | null;
  busy: boolean;
  error: string | null;
  restore(): Promise<void>;
  /**
   * Re-read `/v1/auth/me` after the person changed their own details, so a
   * new name shows everywhere at once. A failure leaves the viewer as it was.
   */
  refreshViewer(): Promise<void>;
  requestOtp(destination: OtpDestination): Promise<{ devCode?: string } | null>;
  verifyOtp(destination: OtpDestination, code: string): Promise<boolean>;
  signOut(): Promise<void>;
  clearError(): void;
}

const AppSessionContext = createContext<SessionValue | null>(null);

export function AppSessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>('restoring');
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionGeneration = useRef(0);

  const fail = useCallback((caught: unknown) => {
    setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.');
  }, []);

  const loadViewer = useCallback(async () => {
    const generation = sessionGeneration.current;
    const response = await api.request<Viewer>('/v1/auth/me');
    if (generation !== sessionGeneration.current || session.state() !== 'authenticated') return false;
    setViewer(response);
    setState('authenticated');
    return true;
  }, []);

  const restore = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (!api.configured) {
        await session.load();
        setState('unauthenticated');
        return;
      }
      const restored = await api.restore();
      if (restored === 'authenticated') {
        setState('restoring');
        await loadViewer();
      } else {
        setViewer(null);
        setState(restored);
      }
    } catch (caught) {
      fail(caught);
      // Tokens alone cannot open Customer/Rider navigation. If /me failed,
      // keep the restore/retry screen until the identity is actually loaded.
      setState(session.state() === 'authenticated' ? 'restoring' : session.state());
    } finally {
      setBusy(false);
    }
  }, [fail, loadViewer]);

  useEffect(() => {
    const unsubscribe = session.subscribe((next) => {
      // Refresh and OTP publish tokens before /me returns. Only loadViewer
      // may publish the provider's authenticated state with its identity.
      if (next === 'authenticated') return;
      sessionGeneration.current += 1;
      setViewer(null);
      setState(next);
    });
    void restore();
    return unsubscribe;
  }, [restore]);

  const refreshViewer = useCallback(async () => {
    if (!api.configured || session.state() !== 'authenticated') return;
    const generation = sessionGeneration.current;
    try {
      const response = await api.request<Viewer>('/v1/auth/me');
      if (generation === sessionGeneration.current && session.state() === 'authenticated') setViewer(response);
    } catch {
      // Keep the viewer already shown; the next restore will correct it.
    }
  }, []);

  const requestOtp = useCallback(async (destination: OtpDestination) => {
    setBusy(true);
    setError(null);
    try {
      return await api.request<{ sent: boolean; expiresInSeconds: number; message: string; devCode?: string }>('/v1/auth/otp/request', {
        method: 'POST',
        auth: false,
        body: { ...destination, purpose: 'login' },
      });
    } catch (caught) {
      fail(caught);
      return null;
    } finally {
      setBusy(false);
    }
  }, [fail]);

  const verifyOtp = useCallback(async (destination: OtpDestination, code: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const tokens = await api.request<{ accessToken: string; csrfToken: string }>('/v1/auth/otp/verify', {
        method: 'POST',
        auth: false,
        body: { ...destination, code, purpose: 'login' },
      });
      await session.adopt(tokens);
      setState('restoring');
      return await loadViewer();
    } catch (caught) {
      fail(caught);
      return false;
    } finally {
      setBusy(false);
    }
  }, [fail, loadViewer]);

  const signOut = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // While the session can still say whose phone this is: stop its pushes.
      // Never throws; the server also silences the phone when the session ends.
      await forgetPushRegistration(api);
      await api.signOut();
      setViewer(null);
      setState('unauthenticated');
    } finally {
      setBusy(false);
    }
  }, []);

  const value = useMemo<SessionValue>(() => ({
    configured: api.configured,
    state,
    viewer,
    busy,
    error,
    restore,
    refreshViewer,
    requestOtp,
    verifyOtp,
    signOut,
    clearError: () => setError(null),
  }), [busy, error, refreshViewer, requestOtp, restore, signOut, state, verifyOtp, viewer]);

  return <AppSessionContext.Provider value={value}>{children}</AppSessionContext.Provider>;
}

export function useAppSession(): SessionValue {
  const value = useContext(AppSessionContext);
  if (!value) throw new Error('useAppSession must be used inside <AppSessionProvider>.');
  return value;
}
