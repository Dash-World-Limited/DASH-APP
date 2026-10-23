'use client';

/**
 * "Can't complete this delivery" for the web rider page (and so the Android
 * shell, which loads it).
 *
 * The same server route and rules as the native app: POST
 * /v1/rider/deliveries/:id/release, before pickup only, with a reason. The
 * server decides everything that matters — whether it is still allowed, where
 * the order goes, and sending the next rider — so this only asks for a reason,
 * makes the rider confirm, and shows the server's answer if it refuses.
 */

import { useState } from 'react';
import { ApiRequestError } from '@/lib/api';
import { authedFetch } from '@/lib/session';
import { Modal } from './Modal';
import { Button } from './ui';

/** Mirrors RELEASE_REASONS in apps/api/src/routes/rider.ts. */
export const RELEASE_REASONS = [
  { value: 'vehicle_problem', label: 'Problem with my vehicle' },
  { value: 'emergency', label: 'Personal emergency' },
  { value: 'vendor_closed_or_unreachable', label: 'Shop is closed or not answering' },
  { value: 'order_not_ready_too_long', label: 'Order not ready after a long wait' },
  { value: 'unsafe_location', label: 'I don’t feel safe going there' },
  { value: 'other', label: 'Something else' },
] as const;

/**
 * Whether to offer the action at all. Only before pickup: once the rider has
 * the order the server refuses, and they have to contact support instead.
 */
export function riderCanRelease(status: string): boolean {
  return status === 'rider_assigned' || status === 'rider_arrived';
}

export function RiderReleaseDialog({
  delivery,
  onClose,
  onDone,
}: {
  delivery: { id: string; code: string };
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (!reason) return;
    setBusy(true);
    setFailure(null);
    try {
      await authedFetch(`/v1/rider/deliveries/${delivery.id}/release`, {
        method: 'POST',
        body: { reasonCode: reason },
      });
      await onDone();
      onClose();
    } catch (caught) {
      setFailure(caught instanceof ApiRequestError ? caught.message : 'That did not go through. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Can’t complete ${delivery.code}?`}
      description="DASH will send another rider. Only do this before you collect the order."
      onClose={onClose}
      labelledBy="release-title"
    >
      <fieldset disabled={busy}>
        <legend className="sr-only">Reason for giving back {delivery.code}</legend>
        <div className="space-y-2">
          {RELEASE_REASONS.map((option) => (
            <label
              key={option.value}
              className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-sm transition-colors ${
                reason === option.value ? 'border-graphite-900 bg-[var(--surface)]' : 'hover:bg-[var(--surface)]'
              }`}
            >
              <input
                type="radio"
                name="release-reason"
                value={option.value}
                checked={reason === option.value}
                onChange={() => setReason(option.value)}
                className="h-4 w-4"
              />
              <span className="font-medium">{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {failure ? (
        <p role="alert" className="mt-4 text-sm font-medium text-coral-600">
          {failure}
        </p>
      ) : null}

      <div className="mt-5 flex gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy} className="flex-1">
          Keep delivery
        </Button>
        <Button variant="danger" onClick={() => void submit()} disabled={!reason || busy} className="flex-1">
          {busy ? 'Giving back…' : 'Give it back'}
        </Button>
      </div>
    </Modal>
  );
}
