'use client';

/**
 * A panel that slides in from the edge, for account-level controls.
 *
 * Everything that is *about the account* rather than about the screen belongs
 * here: who you are signed in as, which mode you are in, and the switches that
 * change either. Keeping them out of the page means a screen can be read for
 * what it is for — a shop, a map, a delivery — without account plumbing
 * competing for the same space.
 *
 * The behaviour matters more than the animation. A drawer that traps a
 * keyboard user, or that leaves the page scrolling underneath it on a phone,
 * is worse than no drawer at all: Escape closes it, the backdrop closes it,
 * focus moves into it on open and returns to the control that opened it on
 * close, and the body is locked while it is up.
 */

import { useEffect, useRef, type ReactNode } from 'react';

export function SideDrawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const returnFocusTo = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;

    returnFocusTo.current = document.activeElement;
    // Focus the panel itself rather than its first control: reading the drawer
    // before acting on it is the normal case, and jumping straight to a button
    // skips the heading that says what this is.
    panel.current?.focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      // Back to whatever opened it, so a keyboard user is not dropped at the
      // top of the document.
      (returnFocusTo.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" role="presentation">
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-[color-mix(in_srgb,var(--color-navy-900)_55%,transparent)]"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="absolute inset-y-0 left-0 flex w-[86%] max-w-sm flex-col overflow-y-auto bg-[var(--surface-raised)] shadow-[var(--shadow-raised)] outline-none"
        style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4">
          <h2 className="text-lg font-bold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="-mr-2 rounded-full p-2 text-[var(--ink-muted)]"
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
            >
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <div className="flex-1 px-5 py-5">{children}</div>
      </div>
    </div>
  );
}

/** The control that opens a drawer. Three lines, so every surface uses one. */
export function MenuButton({ onClick, label = 'Open menu' }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="-ml-2 rounded-full p-2 text-[var(--ink)]"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="h-6 w-6"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
      >
        <path d="M4 7h16M4 12h16M4 17h16" />
      </svg>
    </button>
  );
}
