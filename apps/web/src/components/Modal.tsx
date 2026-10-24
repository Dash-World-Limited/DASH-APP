'use client';

/**
 * Kept out of `ui.tsx` on purpose.
 *
 * `ui.tsx` has no `'use client'` directive, which is what lets server
 * components import `formatNaira` and the rest of its pure helpers. A single
 * hook in that file makes the whole module client-only and the production
 * build fails on every server component that imports it — which is exactly
 * what happened when this component first landed there.
 */

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A modal dialog.
 *
 * A bottom sheet on a phone and a centred card on a desktop, because the
 * vendor console is used on a phone propped against a till far more often than
 * on a laptop. The shape follows the item customiser on the vendor page, which
 * is where this pattern started.
 *
 * Exists because two vendor actions — rejecting an order and verifying a
 * pickup code — were asking for input through `window.prompt()`. That is not a
 * styling complaint: `prompt()` throws outright in a sandboxed or embedded
 * browser, and the throw happened inside an `onClick`, so the rejection simply
 * did not happen and the vendor was told nothing at all.
 *
 * Keyboard and screen-reader behaviour is part of the component rather than
 * left to each caller: Escape closes, focus moves into the dialog on open and
 * returns to the trigger on close, and the heading names the dialog.
 */
export function Modal({
  title,
  description,
  onClose,
  children,
  labelledBy = 'modal-title',
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  labelledBy?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Restored on unmount so closing the dialog does not dump the vendor back
    // at the top of the page — they were mid-way down a queue of orders.
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-[var(--ink)]/50 p-0 sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-[var(--surface-raised)] outline-none sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b p-5">
          <div>
            <h2 id={labelledBy} className="text-lg font-bold">
              {title}
            </h2>
            {description ? (
              <p className="mt-1 text-sm text-[var(--ink-muted)]">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg px-3 py-1 text-xl leading-none hover:bg-graphite-100"
          >
            ×
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
