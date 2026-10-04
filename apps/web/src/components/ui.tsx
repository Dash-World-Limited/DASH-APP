/**
 * Shared UI primitives.
 *
 * Small and deliberately unclever. Each one exists because the same pattern
 * appeared in three or more screens, not because a design system was planned
 * up front.
 */

import type { ReactNode } from 'react';

import { DashWordmark } from './brand/DashWordmark';

export function formatNaira(kobo: number): string {
  const negative = kobo < 0;
  const abs = Math.abs(kobo);
  const whole = Math.trunc(abs / 100).toLocaleString('en-NG');
  const fraction = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}₦${whole}.${fraction}`;
}

export function formatNairaCompact(kobo: number): string {
  const negative = kobo < 0;
  const whole = Math.round(Math.abs(kobo) / 100).toLocaleString('en-NG');
  return `${negative ? '-' : ''}₦${whole}`;
}

export function formatDistance(metres: number | null): string {
  if (metres === null) return '';
  if (metres < 1000) return `${Math.round(metres)}m`;
  return `${(metres / 1000).toFixed(1)}km`;
}

// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--primary)] text-[var(--ink)] hover:bg-[var(--primary-hover)] active:bg-gold-600 disabled:bg-graphite-200 disabled:text-[var(--ink-muted)]',
  secondary:
    'bg-[var(--ink)] text-white hover:bg-graphite-800 disabled:bg-graphite-200 disabled:text-[var(--ink-muted)]',
  ghost:
    'bg-transparent border border-[var(--line)] text-[var(--ink)] hover:bg-[var(--surface-raised)]',
  danger: 'bg-coral-400 text-white hover:bg-coral-600 disabled:bg-graphite-200',
};

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  // Touch targets are at least 44px tall at md and above — riders and couriers
  // use these one-handed, often while wearing gloves.
  const sizes = {
    sm: 'text-sm px-3 py-1.5 min-h-8',
    md: 'text-sm px-4 py-2.5 min-h-11',
    lg: 'text-base px-6 py-3.5 min-h-14',
  };

  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors disabled:cursor-not-allowed ${BUTTON_STYLES[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function Card({
  children,
  className = '',
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'article' | 'section' | 'li';
}) {
  return (
    <Tag
      className={`rounded-[var(--radius-card)] border bg-[var(--surface-raised)] ${className}`}
    >
      {children}
    </Tag>
  );
}

type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'gold';

const BADGE_STYLES: Record<BadgeTone, string> = {
  neutral: 'bg-graphite-100 text-graphite-600',
  success: 'bg-[var(--success-soft)] text-[var(--success)]',
  warning: 'bg-[var(--primary-soft)] text-[var(--primary)]',
  danger: 'bg-[var(--danger-soft)] text-[var(--danger)]',
  gold: 'bg-[var(--primary)] text-[var(--ink)]',
};

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: BadgeTone;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${BADGE_STYLES[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Loading placeholder.
 *
 * `aria-hidden` with a sibling live region: a screen reader should hear
 * "Loading" once, not read out a dozen empty grey boxes.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`dash-pulse rounded-lg bg-graphite-100 ${className}`} />;
}

export function LoadingBlock({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="space-y-3">
      <span className="sr-only" role="status">
        {label}
      </span>
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

/** Empty state. Always says what to do next, never just "no results". */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed px-6 py-12 text-center">
      <p className="text-base font-semibold">{title}</p>
      <p className="mx-auto mt-2 max-w-sm text-sm text-[var(--ink-muted)]">{description}</p>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

/**
 * Error state.
 *
 * Shows the request id when there is one. That id is the only thing that links
 * what the user saw to what the server logged, and asking a support agent to
 * find an incident without it is hopeless.
 */
export function ErrorState({
  title = 'Something went wrong',
  message,
  requestId,
  onRetry,
}: {
  title?: string;
  message: string;
  requestId?: string | undefined;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-[var(--radius-card)] border border-[var(--danger)]/40 bg-[var(--danger-soft)] px-5 py-4"
    >
      <p className="font-semibold text-[var(--danger)]">{title}</p>
      <p className="mt-1 text-sm text-graphite-600">{message}</p>
      {requestId ? (
        <p className="mt-2 font-mono text-xs text-[var(--ink-muted)]">Reference: {requestId}</p>
      ) : null}
      {onRetry ? (
        <Button variant="ghost" size="sm" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && !error ? <p className="text-xs text-[var(--ink-muted)]">{hint}</p> : null}
      {error ? (
        <p role="alert" className="text-xs font-medium text-[var(--danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Input({
  className = '',
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-xl border bg-[var(--surface-raised)] px-3.5 py-2.5 text-[var(--ink)] placeholder:text-[var(--ink-muted)] ${className}`}
      {...props}
    />
  );
}

/**
 * The DASH wordmark: the measured artwork from the approved boards, never
 * typed and never followed by a dot (that was the retired mark). `className`
 * still sets its scale through font-size and its D and A through colour.
 */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center ${className}`}>
      <DashWordmark />
    </span>
  );
}

/**
 * A "this is an estimate" marker.
 *
 * Used everywhere an ETA appears. The distinction between an estimate and a
 * promise matters commercially and legally, and burying it is how a delivery
 * platform ends up in a dispute it cannot win.
 */
export function EstimateNote({ children }: { children: ReactNode }) {
  return <span className="text-xs text-[var(--ink-muted)]">{children}</span>;
}
