'use client';

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export const DECLUTTER_THEME_KEY = 'dash-declutter-theme';
export type DeclutterTheme = 'light' | 'dark';
export function preferredTheme(
  saved: string | null,
  systemDark: boolean,
): DeclutterTheme {
  return saved === 'light' || saved === 'dark'
    ? saved
    : systemDark
      ? 'dark'
      : 'light';
}
// Runs during HTML parsing, before this surface's content paints. Only this
// wrapper changes; DASH App and generic admin surfaces keep their own tokens.
export const themeBootstrap = `try{var s=document.currentScript.parentElement;var t=localStorage.getItem('${DECLUTTER_THEME_KEY}');s.dataset.declutterTheme=t==='light'||t==='dark'?t:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}catch(e){document.currentScript.parentElement.dataset.declutterTheme=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}`;
const ThemeContext = createContext<{
  theme: DeclutterTheme | null;
  toggle: () => void;
}>({ theme: null, toggle: () => {} });

export function DeclutterThemeShell({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  const [theme, setTheme] = useState<DeclutterTheme | null>(null);
  const shell = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const system = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(DECLUTTER_THEME_KEY);
      } catch {
        /* Private browsing still supports the toggle. */
      }
      setTheme(preferredTheme(saved, system.matches));
    };
    sync();
    system.addEventListener('change', sync);
    window.addEventListener('storage', sync);
    return () => {
      system.removeEventListener('change', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  function toggle() {
    const current =
      theme ??
      (shell.current?.dataset.declutterTheme as DeclutterTheme | undefined) ??
      'light';
    const next = current === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(DECLUTTER_THEME_KEY, next);
    } catch {
      /* In-memory choice survives client navigation. */
    }
    setTheme(next);
  }
  return (
    <ThemeContext.Provider value={{ theme, toggle }}>
      <div
        ref={shell}
        data-surface="declutter"
        data-declutter-theme={theme ?? undefined}
        suppressHydrationWarning
        className={`min-h-dvh ${className}`}
      >
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        {children}
      </div>
    </ThemeContext.Provider>
  );
}

export function DeclutterThemeToggle() {
  const { theme, toggle } = useContext(ThemeContext);
  return (
    <button
      type="button"
      onClick={toggle}
      className="dcl-theme-toggle inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[var(--line-strong)] bg-[var(--surface-raised)]"
      aria-label={
        theme === 'dark'
          ? 'Switch to light mode'
          : theme === 'light'
            ? 'Switch to dark mode'
            : 'Toggle colour theme'
      }
      title="Light / dark mode"
    >
      <svg
        className="dcl-theme-sun"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
      </svg>
      <svg
        className="dcl-theme-moon"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        aria-hidden="true"
      >
        <path d="M20.8 14A9 9 0 0 1 10 3.2 9 9 0 1 0 20.8 14Z" />
      </svg>
    </button>
  );
}
