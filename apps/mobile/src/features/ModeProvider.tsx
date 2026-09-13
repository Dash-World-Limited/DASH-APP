/**
 * Remembers which face the app last showed, so a rider reopening DASH mid-shift
 * lands on the Rider home rather than the shop grid.
 *
 * Loaded before the splash screen hides, like the theme, so there is no flash
 * of the wrong face on launch.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { MODE_STORAGE_KEY, parseMode, type AppMode } from './mode';

interface ModeValue {
  mode: AppMode;
  setMode: (next: AppMode) => void;
  ready: boolean;
}

const ModeContext = createContext<ModeValue | null>(null);

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<AppMode>('customer');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(MODE_STORAGE_KEY)
      .then((raw) => !cancelled && setModeState(parseMode(raw)))
      .catch(() => undefined)
      .finally(() => !cancelled && setReady(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback((next: AppMode) => {
    setModeState(next);
    AsyncStorage.setItem(MODE_STORAGE_KEY, next).catch(() => undefined);
  }, []);

  const value = useMemo(() => ({ mode, setMode, ready }), [mode, setMode, ready]);
  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export function useAppMode(): ModeValue {
  const value = useContext(ModeContext);
  if (!value) throw new Error('useAppMode must be used inside <ModeProvider>.');
  return value;
}
