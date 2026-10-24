'use client';

/**
 * The frame every Declutters auth screen sits in.
 *
 * One component rather than three near-identical pages, because sign in, create
 * account and verify differ by a heading and a form — and three copies of a
 * layout is three places for a focus ring, an error region or a heading level
 * to drift.
 *
 * It is the website's own furniture. No `AppHeader`, no Basket, no bottom
 * navigation: somebody signing in to ask about a sofa is on a marketplace
 * website, and handing them the DASH APP shell at the moment they are deciding
 * whether to trust this company with an email address is the wrong answer.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';

export function AuthShell({
  eyebrow,
  title,
  lede,
  children,
  footer,
}: {
  eyebrow: string;
  title: string;
  lede: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main id="main" className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute -left-40 -top-52 h-[34rem] w-[34rem] rounded-full opacity-30 blur-[130px]"
        style={{ background: 'radial-gradient(circle, rgba(77,124,255,0.5), transparent 65%)' }}
      />

      <div className="relative mx-auto w-full max-w-md px-5 py-16 sm:py-24">
        <p className="dcl-eyebrow">{eyebrow}</p>
        <h1 className="dcl-display mt-4 text-3xl sm:text-4xl">{title}</h1>
        <p className="mt-4 text-sm leading-relaxed text-[var(--ink-muted)]">{lede}</p>

        <div className="dcl-glass mt-8 rounded-[var(--radius-card)] p-6">{children}</div>

        {footer ? <div className="mt-6 text-sm text-[var(--ink-muted)]">{footer}</div> : null}

        <p className="mt-10 text-xs leading-relaxed text-[var(--ink-muted)]">
          One DASH account works across everything Dash World builds. Your details are never
          published on a listing.{' '}
          <Link href="/declutter" className="underline hover:text-[var(--ink)]">
            Back to the marketplace
          </Link>
        </p>
      </div>
    </main>
  );
}

/** A labelled text field. Every auth input on the site is one of these. */
export function AuthField({
  id,
  label,
  hint,
  ...props
}: {
  id: string;
  label: string;
  hint?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
      </label>
      <input
        id={id}
        {...props}
        className="mt-2 min-h-12 w-full rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)] px-4 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)] focus:border-[var(--primary)]"
      />
      {hint ? <p className="mt-1.5 text-xs text-[var(--ink-muted)]">{hint}</p> : null}
    </div>
  );
}

export function AuthError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    // `role="alert"` so a screen reader hears the refusal without the person
    // having to go looking for why nothing happened.
    <p role="alert" className="mt-4 text-sm font-semibold text-[var(--danger)]">
      {message}
    </p>
  );
}

export function AuthSubmit({
  children,
  ...props
}: { children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="submit"
      {...props}
      className="mt-6 min-h-12 w-full rounded-full bg-[var(--primary)] px-7 text-sm font-bold text-[var(--on-primary)] transition-colors hover:bg-[var(--primary-hover)] disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/**
 * The development code, shown on screen.
 *
 * Only ever rendered when the API chose to return one, which it does outside
 * production and behind a flag `config.ts` refuses to start a production
 * process with. Two independent guards already stand behind this; printing it
 * here saves scraping a log during local testing and can never reach a real
 * user.
 */
export function DevCode({ code }: { code: string | null }) {
  if (!code) return null;
  return (
    <p className="mt-4 rounded-xl border border-dashed border-[var(--line-strong)] px-4 py-3 text-xs text-[var(--ink-muted)]">
      Development only — your code is{' '}
      <strong className="font-mono text-sm text-[var(--ink)]">{code}</strong>
    </p>
  );
}
