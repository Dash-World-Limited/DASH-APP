'use client';
import { useEffect, useRef, useState } from 'react';
import { authedFetch } from '@/lib/session';
import { hubButton, type HubItem } from './hub-types';

export function RemoveItem({
  item,
  onChanged,
}: {
  item: HubItem;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const live = Boolean(item.listing);
  const label = live ? 'Remove listing' : 'Delete submission';
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else if (dialog.current?.open) {
      dialog.current.close();
      trigger.current?.focus();
    }
  }, [open]);
  if (item.status === 'Removed' || item.status === 'Sold') return null;
  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await authedFetch(`/v1/declutter/account/items/${item.id}/remove`, {
        method: 'POST',
        body: { confirmed: true },
      });
      setOpen(false);
      await onChanged();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Could not remove your item. Please retry.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="dcl-remove rounded-2xl border border-[var(--line)] p-5">
      <h2 className="font-bold">No longer selling this item?</h2>
      <p className="mt-2 text-sm text-[var(--ink-muted)]">
        Remove it from your active items. Your history and conversations stay
        available.
      </p>
      <button
        ref={trigger}
        className={`${hubButton} mt-4 text-[var(--danger)]`}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      <dialog
        ref={dialog}
        className="dcl-removal-dialog"
        aria-labelledby="remove-item-title"
        onCancel={(e) => {
          if (busy) e.preventDefault();
          else setOpen(false);
        }}
      >
        <h2 id="remove-item-title" className="text-xl font-bold">
          {label}?
        </h2>
        <p className="mt-3 text-sm leading-relaxed">
          {live
            ? 'Your listing will leave the public marketplace immediately.'
            : 'This submission will move to your removed items and will not be published.'}{' '}
          This cannot be undone from your account. Your messages and item
          history will be kept.
        </p>
        {error ? (
          <p role="alert" className="mt-4 text-sm text-[var(--danger)]">
            {error}
          </p>
        ) : null}
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <button
            autoFocus
            className={hubButton}
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            Keep item
          </button>
          <button
            className={`${hubButton} bg-[var(--danger)] text-[var(--surface-sunken)]`}
            disabled={busy}
            onClick={() => void remove()}
          >
            {busy ? 'Removing…' : label}
          </button>
        </div>
      </dialog>
    </section>
  );
}
