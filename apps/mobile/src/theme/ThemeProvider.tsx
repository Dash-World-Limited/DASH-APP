/**
 * Supplies the resolved palette to every screen, and remembers the choice.
 *
 * The preference is loaded before first paint — the root layout keeps the
 * splash screen up until `ready` — so someone who chose Dark never sees a
 * flash of Light on launch. The native root background follows the palette as
 * well, which is what stops a white frame showing between screen transitions
 * on Android.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SystemUI from 'expo-system-ui';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { APPEARANCE_STORAGE_KEY, DEFAULT_APPEARANCE, parseAppearance, type AppearancePreference } from './appearance';
import { palettes, type ColorScheme, type Palette } from './tokens';

interface ThemeValue {
  scheme: ColorScheme;
  palette: Palette;
  setAppearance: (next: AppearancePreference) => void;
  /** False until the stored preference has been read. */
  ready: boolean;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [scheme, setScheme] = useState<ColorScheme>(DEFAULT_APPEARANCE);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(APPEARANCE_STORAGE_KEY)
      .then((raw) => {
        if (!cancelled) setScheme(parseAppearance(raw));
      })
      .catch(() => {
        // Unreadable storage is not a reason to block the app: stay on Light.
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(palettes[scheme].background);
  }, [scheme]);

  const setAppearance = useCallback((next: AppearancePreference) => {
    setScheme(next);
    // Fire and forget. A failed write costs the preference on next launch and
    // nothing else; blocking the switch on storage would make it feel broken.
    AsyncStorage.setItem(APPEARANCE_STORAGE_KEY, next).catch(() => undefined);
  }, []);

  const value = useMemo<ThemeValue>(
    () => ({ scheme, palette: palettes[scheme], setAppearance, ready }),
    [scheme, setAppearance, ready],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside <ThemeProvider>.');
  return value;
}
