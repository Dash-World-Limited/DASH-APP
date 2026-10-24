/**
 * Remembers which face the app last showed, so a rider reopening DASH mid-shift
 * lands on the Rider home rather than the shop grid.
 *
 * Loaded before the splash screen hides, like the theme, so there is no flash
 * of the wrong face on launch. The launch redirect itself is owned by the
 * Customer layout and described in `modeReducer`.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';

import { INITIAL_MODE_STATE, MODE_STORAGE_KEY, modeReducer, type AppMode } from './mode';

interface ModeValue {
  mode: AppMode;
  setMode: (next: AppMode) => void;
  ready: boolean;
  /** 'rider' while the app still owes a remembered rider their launch redirect. */
  launchFace: 'rider' | null;
  /** Called by a face's layout when it mounts. */
  arrivedAt: (face: AppMode) => void;
}

const ModeContext = createContext<ModeValue | null>(null);

export function ModeProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(modeReducer, INITIAL_MODE_STATE);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(MODE_STORAGE_KEY)
      .catch(() => null)
      .then((stored) => {
        if (!cancelled) dispatch({ type: 'loaded', stored });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback((next: AppMode) => {
    dispatch({ type: 'switched', to: next });
    AsyncStorage.setItem(MODE_STORAGE_KEY, next).catch(() => undefined);
  }, []);

  const arrivedAt = useCallback((face: AppMode) => dispatch({ type: 'arrived', face }), []);

  const value = useMemo(
    () => ({ mode: state.mode, setMode, ready: state.ready, launchFace: state.launchFace, arrivedAt }),
    [state, setMode, arrivedAt],
  );
  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export function useAppMode(): ModeValue {
  const value = useContext(ModeContext);
  if (!value) throw new Error('useAppMode must be used inside <ModeProvider>.');
  return value;
}
