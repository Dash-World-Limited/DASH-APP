'use client';

/**
 * Move between the customer and rider faces of one account.
 *
 * The control renders only for an identity the server has approved to work, so
 * a customer never sees an option that would fail. That is a courtesy, not a
 * defence: every rider route authorises against the caller's own identity, and
 * a customer-only account is refused whether or not this button exists. The
 * check here decides what to draw, never what is allowed.
 *
 * Switching navigates. It does not sign anything out, exchange a token, or
 * create a second session — the whole point of one identity holding both
 * capabilities is that there is nothing to swap.
 */

import { useRouter } from 'next/navigation';

import { useMe } from '@/lib/session';
import { canUseRiderMode, homeFor, rememberMode, type AppMode } from '@/lib/mode';

export function ModeSwitch({ to, className = '' }: { to: AppMode; className?: string }) {
  const { me, loaded } = useMe();
  const router = useRouter();

  // Rendered only once the server has answered. Guessing during hydration
  // would flash an option that may not survive the answer.
  if (!loaded) return null;
  if (to === 'rider' && !canUseRiderMode(me)) return null;

  const label = to === 'rider' ? 'Switch to Rider' : 'Switch to Customer';
  const description =
    to === 'rider'
      ? 'Go online, take deliveries and track your earnings.'
      : 'Browse vendors and order for yourself.';

  return (
    <button
      type="button"
      onClick={() => {
        rememberMode(to);
        router.push(homeFor(to));
      }}
      className={`flex w-full items-center justify-between gap-4 rounded-[var(--radius-card)] border border-[var(--line)] bg-[var(--surface-raised)] p-4 text-left transition-colors hover:border-[var(--primary)] ${className}`}
    >
      <span>
        <span className="block font-bold text-[var(--ink)]">{label}</span>
        <span className="mt-0.5 block text-sm text-[var(--ink-muted)]">{description}</span>
      </span>
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="h-5 w-5 shrink-0 text-[var(--primary)]"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 12h14M13 6l6 6-6 6" />
      </svg>
    </button>
  );
}
