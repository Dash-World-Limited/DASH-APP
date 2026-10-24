/**
 * Saved shops and products — the hearts on the boards.
 *
 * Kept on this device. The backend has no saved-items concept yet, so this is
 * a real, working, device-local list rather than a heart that fills and then
 * forgets. When saved items reach the account, this is where the sync goes;
 * until then nothing claims they follow a person to another phone.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

const KEY = 'dash.saved.v1';

interface SavedValue {
  isSaved: (id: string) => boolean;
  toggle: (id: string) => void;
}

const SavedContext = createContext<SavedValue | null>(null);

export function SavedProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) setIds(new Set(parsed.filter((v): v is string => typeof v === 'string')));
      })
      .catch(() => undefined);
  }, []);

  const toggle = useCallback((id: string) => {
    setIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      AsyncStorage.setItem(KEY, JSON.stringify([...next])).catch(() => undefined);
      return next;
    });
  }, []);

  const value = useMemo<SavedValue>(() => ({ isSaved: (id) => ids.has(id), toggle }), [ids, toggle]);
  return <SavedContext.Provider value={value}>{children}</SavedContext.Provider>;
}

export function useSaved(): SavedValue {
  const value = useContext(SavedContext);
  if (!value) throw new Error('useSaved must be used inside <SavedProvider>.');
  return value;
}
