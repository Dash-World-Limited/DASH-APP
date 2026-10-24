'use client';

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'dash.admin.appearance';
type AdminTheme = 'light' | 'dark';

export function AdminThemeToggle({
  theme,
  onChange,
}: {
  theme: AdminTheme;
  onChange: (theme: AdminTheme) => void;
}) {
  return (
    <div
      className="flex rounded-xl bg-[var(--surface-sunken)] p-1"
      role="radiogroup"
      aria-label="Appearance"
    >
      {(['light', 'dark'] as const).map((value) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(value)}
            className={
              'min-h-9 flex-1 rounded-lg px-3 text-xs font-bold capitalize transition ' +
              (active
                ? 'bg-[var(--ink)] text-[var(--ink-inverted)] shadow-sm'
                : 'text-[var(--ink-muted)] hover:text-[var(--ink)]')
            }
          >
            {value}
          </button>
        );
      })}
    </div>
  );
}

export function useAdminTheme(): {
  theme: AdminTheme;
  setTheme: (theme: AdminTheme) => void;
  ready: boolean;
} {
  const [theme, setThemeState] = useState<AdminTheme>('light');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === 'dark' || stored === 'light') setThemeState(stored);
    } finally {
      setReady(true);
    }
  }, []);

  const setTheme = (next: AdminTheme) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Appearance still changes for this tab when storage is unavailable.
    }
  };

  return { theme, setTheme, ready };
}
