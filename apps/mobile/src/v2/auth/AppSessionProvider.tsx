import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { api, ApiError, session, type SessionState } from '../../api';

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

  const fail = useCallback((caught: unknown) => {
    setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.');
  }, []);

  const loadViewer = useCallback(async () => {
    const response = await api.request<Viewer>('/v1/auth/me');
    setViewer(response);
    setState('authenticated');
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
      setState(restored);
      if (restored === 'authenticated') await loadViewer();
    } catch (caught) {
      fail(caught);
      setState(session.state());
    } finally {
      setBusy(false);
    }
  }, [fail, loadViewer]);

  useEffect(() => {
    void restore();
    return session.subscribe(setState);
  }, [restore]);

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
      await loadViewer();
      return true;
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
    requestOtp,
    verifyOtp,
    signOut,
    clearError: () => setError(null),
  }), [busy, error, requestOtp, restore, signOut, state, verifyOtp, viewer]);

  return <AppSessionContext.Provider value={value}>{children}</AppSessionContext.Provider>;
}

export function useAppSession(): SessionValue {
  const value = useContext(AppSessionContext);
  if (!value) throw new Error('useAppSession must be used inside <AppSessionProvider>.');
  return value;
}
