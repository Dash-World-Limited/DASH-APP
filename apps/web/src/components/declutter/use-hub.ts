'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { authedFetch, useSessionState } from '@/lib/session';
export function useHub<T>(url: string | null) {
  const session = useSessionState();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!url || session !== 'authenticated') return;
    const current = generation.current;
    try {
      const next = await authedFetch<T>(url);
      if (current === generation.current) {
        setData(next);
        setError(null);
      }
    } catch (caught) {
      if (current === generation.current)
        setError(
          caught instanceof Error
            ? caught.message
            : 'Could not load. Try again.',
        );
    }
  }, [url, session]);
  useEffect(() => {
    generation.current++;
    setData(null);
    setError(null);
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 15_000);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [refresh]);
  return { data, error, refresh, session };
}
