'use client';

/**
 * The vendor actions that need something from the person at the counter.
 *
 * Both used to be `window.prompt()`. That is not merely an ugliness: `prompt()`
 * throws outright in a sandboxed or embedded browser, and the call sat inside
 * an `onClick`, so the throw meant the request was never sent and the vendor
 * was shown nothing at all. Pressing Reject left the order sitting in the queue
 * with no error, no spinner, and no clue.
 *
 * They live here rather than in the page because a dialog that submits a
 * request is the part worth testing, and a page component that also owns
 * tabs, polling, and a socket is not a practical thing to render in a test.
 */

import { useState } from 'react';
import { ApiRequestError } from '@/lib/api';
import { authedFetch } from '@/lib/session';
import { Modal } from './Modal';
import { Button, Field, Input } from './ui';

/** All either dialog needs. Kept minimal so the page's own row type can widen. */
export interface DialogOrder {
  id: string;
  code: string;
}

/**
 * The reasons the API accepts.
 *
 * Mirrors the `reasonCode` enum on `POST /v1/vendor/orders/:id/reject`. A
 * rejection reason is not a formality — it feeds the vendor's reliability
 * score and the customer's refund copy — so it is picked from this list rather
 * than typed, and the dialog will not submit without one. Defaulting to
 * "other" would be easier and would quietly make every rejection meaningless.
 */
export const REJECT_REASONS = [
  { value: 'out_of_stock', label: 'Out of stock' },
  { value: 'too_busy', label: 'Too busy right now' },
  { value: 'closing_soon', label: 'Closing soon' },
  { value: 'cannot_fulfil_instructions', label: 'Cannot meet the instructions' },
  { value: 'other', label: 'Another reason' },
] as const;

function messageFor(caught: unknown, fallback: string): string {
  return caught instanceof ApiRequestError ? caught.message : fallback;
}

/**
 * The reasons the API accepts for cancelling an accepted order.
 *
 * Mirrors the `reasonCode` enum on `POST /v1/vendor/orders/:id/cancel`.
 */
export const CANCEL_REASONS = [
  { value: 'out_of_stock', label: 'Ran out of something in the order' },
  { value: 'kitchen_problem', label: 'Problem in the kitchen or shop' },
  { value: 'closing_early', label: 'Closing early' },
  { value: 'cannot_fulfil_instructions', label: 'Cannot meet the instructions' },
  { value: 'other', label: 'Another reason' },
] as const;

interface ReasonDialogCopy {
  url: string;
  reasons: readonly { value: string; label: string }[];
  title: string;
  description: string;
  name: string;
  legend: string;
  keepLabel: string;
  confirmLabel: string;
  busyLabel: string;
}

/** A dialog that will not submit without a reason picked from the API's list. */
function ReasonDialog({
  copy,
  onClose,
  onDone,
}: {
  copy: ReasonDialogCopy;
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
      await authedFetch(copy.url, {
        method: 'POST',
        body: { reasonCode: reason },
      });
      await onDone();
      onClose();
    } catch (caught) {
      // Stays open, with the chosen reason intact, so a retry does not mean
      // picking it again.
      setFailure(messageFor(caught, 'That did not go through. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={copy.title}
      description={copy.description}
      onClose={onClose}
      labelledBy={`${copy.name}-title`}
    >
      <fieldset disabled={busy}>
        <legend className="sr-only">{copy.legend}</legend>
        <div className="space-y-2">
          {copy.reasons.map((option) => (
            <label
              key={option.value}
              className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-sm transition-colors ${
                reason === option.value
                  ? 'border-graphite-900 bg-[var(--surface)]'
                  : 'hover:bg-[var(--surface)]'
              }`}
            >
              <input
                type="radio"
                name={`${copy.name}-reason`}
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
          {copy.keepLabel}
        </Button>
        <Button
          variant="danger"
          onClick={() => void submit()}
          disabled={!reason || busy}
          className="flex-1"
        >
          {busy ? copy.busyLabel : copy.confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

export function RejectDialog({
  order,
  onClose,
  onDone,
}: {
  order: DialogOrder;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  return (
    <ReasonDialog
      copy={{
        url: `/v1/vendor/orders/${order.id}/reject`,
        reasons: REJECT_REASONS,
        title: `Reject ${order.code}?`,
        description: 'The customer is refunded in full and told why.',
        name: 'reject',
        legend: `Reason for rejecting ${order.code}`,
        keepLabel: 'Keep order',
        confirmLabel: 'Reject order',
        busyLabel: 'Rejecting…',
      }}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/**
 * Cancel an order the vendor has already accepted, before a rider collects
 * it. The server withdraws any rider offer, stands down a rider on the way,
 * and queues the customer's full refund, as for a rejection.
 */
export function CancelDialog({
  order,
  onClose,
  onDone,
}: {
  order: DialogOrder;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  return (
    <ReasonDialog
      copy={{
        url: `/v1/vendor/orders/${order.id}/cancel`,
        reasons: CANCEL_REASONS,
        title: `Cancel ${order.code}?`,
        description:
          'The customer is refunded in full and told why. Any rider on the way is stood down. This cannot be undone.',
        name: 'cancel',
        legend: `Reason for cancelling ${order.code}`,
        keepLabel: 'Keep order',
        confirmLabel: 'Cancel order',
        busyLabel: 'Cancelling…',
      }}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/**
 * Check the rider's pickup code before the food leaves the counter.
 *
 * The code is the only thing tying the person at the counter to the order, so
 * a wrong one has to be visibly wrong and a right one has to be visibly right.
 * The `alert()` this replaces could express neither where `prompt()` had
 * already thrown.
 */
export function PickupDialog({
  order,
  onClose,
  onDone,
}: {
  order: DialogOrder;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await authedFetch(`/v1/vendor/orders/${order.id}/verify-pickup`, {
        method: 'POST',
        body: { code },
      });
      setVerified(true);
      await onDone();
    } catch (caught) {
      setFailure(messageFor(caught, 'That code was not accepted. Check it with the rider.'));
    } finally {
      setBusy(false);
    }
  };

  if (verified) {
    return (
      <Modal
        title="Code verified"
        description={`Hand ${order.code} to the rider.`}
        onClose={onClose}
        labelledBy="pickup-title"
      >
        <p className="text-sm text-[var(--ink-muted)]">
          The rider is confirmed as the one assigned to this order.
        </p>
        <Button onClick={onClose} className="mt-5 w-full">
          Done
        </Button>
      </Modal>
    );
  }

  return (
    <Modal
      title={`Pickup code for ${order.code}`}
      description="Ask the rider to read out their four-digit code."
      onClose={onClose}
      labelledBy="pickup-title"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Rider's code" htmlFor="pickup-code" error={failure ?? undefined}>
          <Input
            id="pickup-code"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 4))}
            // A phone keypad rather than a full keyboard, and the browser is
            // told not to autofill a one-time code it has no business knowing.
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            placeholder="0000"
            aria-describedby="pickup-help"
            className="text-center font-mono text-2xl tracking-[0.4em]"
          />
        </Field>
        <p id="pickup-help" className="mt-1.5 text-xs text-[var(--ink-muted)]">
          Four digits. The rider sees it in their app.
        </p>

        <div className="mt-5 flex gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy} className="flex-1">
            Cancel
          </Button>
          <Button type="submit" disabled={code.length !== 4 || busy} className="flex-1">
            {busy ? 'Checking…' : 'Verify'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
