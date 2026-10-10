'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiRequestError } from '@/lib/api';
import { authedFetch, signOut, useMe, useSessionState } from '@/lib/session';
import { signInHref } from '@/lib/return-to';

interface Submission { id: string; code: string; title: string | null; status: string }
interface Listing {
  id: string; submissionId: string | null; slug: string; title: string;
  moderationStatus: string; availability: string; publishedAt: string | null; priceKobo: number;
}
export interface AccountSummary {
  seller: { kycStatus: string; canSubmit: boolean } | null;
  submissions: Submission[];
  listings: Listing[];
}

const labels: Record<string, string> = {
  draft: 'Draft', intake: 'Under Review', kyc_pending: 'Verification Required',
  details_pending: 'Changes Requested', fraud_review: 'Under Review', valuation_pending: 'Under Review',
  pricing_review: 'Under Review', seller_acceptance_pending: 'Price Awaiting Your Reply',
  approved: 'Approved', published: 'Under Review', rejected: 'Not Approved', withdrawn: 'Withdrawn',
};
const verification: Record<string, string> = {
  unverified: 'Verification Required', pending: 'Under Review', verified: 'Verified',
  rejected: 'Update Required', suspended: 'Selling Paused',
};
const button = 'inline-flex min-h-11 items-center justify-center rounded-full border border-[var(--line-strong)] px-5 text-sm font-bold';

export function DeclutterAccount() {
  const session = useSessionState();
  const { me, loaded } = useMe();
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [signingOut, setSigningOut] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    setError(null);
    if (session !== 'authenticated') return;
    void authedFetch<AccountSummary>('/v1/declutter/account').then((data) => {
      if (!cancelled) setSummary(data);
    }).catch((caught) => {
      if (!cancelled) setError(caught instanceof ApiRequestError ? caught.message : 'Could not load your items. Please try again.');
    });
    return () => { cancelled = true; };
  }, [session, reload]);

  const rows = summary ? [
    ...summary.submissions.map((submission) => ({ submission, listing: summary.listings.find(l => l.submissionId === submission.id) })),
    ...summary.listings.filter(l => !summary.submissions.some(s => s.id === l.submissionId)).map(listing => ({ submission: undefined, listing })),
  ] : [];
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const listing = row.listing;
    const status = listing?.availability === 'sold' ? 'Sold'
      : listing?.availability === 'archived' ? 'Archived'
      : listing?.moderationStatus === 'suspended' ? 'Paused'
      : listing?.publishedAt && listing.moderationStatus === 'approved' && ['available', 'reserved'].includes(listing.availability) ? 'Live'
      : listing?.moderationStatus === 'rejected' ? 'Not Approved'
      : row.submission ? labels[row.submission.status] ?? 'Under Review'
      : listing?.moderationStatus === 'approved' ? 'Approved' : listing?.moderationStatus === 'draft' ? 'Draft' : 'Under Review';
    groups.set(status, [...(groups.get(status) ?? []), row]);
  }

  return <main id="main">
    <section className="border-b border-[var(--line)]">
      <div className="mx-auto w-full max-w-[1240px] px-5 py-14 sm:px-8 sm:py-16">
        <p className="dcl-eyebrow">Your account</p>
        <h1 className="dcl-display mt-4 text-3xl font-extrabold sm:text-5xl">Your Declutters, in one place.</h1>
        <p className="mt-4 max-w-xl text-sm leading-relaxed text-[var(--ink-muted)]">Follow your items from submission to sale, and keep track of your seller verification.</p>
      </div>
    </section>
    <div className="mx-auto w-full max-w-[1240px] px-5 py-10 sm:px-8 sm:py-14">
      {session === 'restoring' ? <p role="status">Checking your account…</p>
        : session === 'unauthenticated' ? <section className="dcl-glass rounded-[var(--radius-card)] p-6 sm:p-8">
          <h2 className="text-xl font-bold">Sign in to your Declutters account</h2>
          <p className="mt-3 text-sm text-[var(--ink-muted)]">See your seller status and the items you have submitted to DASH.</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href={signInHref('/declutter/account')} className={button}>Sign in</Link>
            <Link href="/declutter/join?next=%2Fdeclutter%2Faccount" className={`${button} bg-[var(--primary)] text-[var(--on-primary)]`}>Create account</Link>
          </div>
        </section> : <div className="grid min-w-0 gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="min-w-0 space-y-5">
            <section className="dcl-glass rounded-[var(--radius-card)] p-6">
              <p className="dcl-eyebrow">DASH account</p>
              <h2 className="mt-3 break-words text-xl font-bold">{me?.identity.displayName || (loaded ? 'Your account' : 'Loading…')}</h2>
              <p className="mt-2 break-all text-sm text-[var(--ink-muted)]">{me?.identity.email}</p>
              <button type="button" disabled={signingOut} className={`${button} mt-6 w-full disabled:opacity-50`} onClick={() => {
                setSigningOut(true);
                void signOut().finally(() => setSigningOut(false));
              }}>{signingOut ? 'Signing out…' : 'Sign out'}</button>
            </section>
            {summary ? <section className="dcl-glass rounded-[var(--radius-card)] p-6">
              <p className="dcl-eyebrow">Seller verification</p>
              <h2 className="mt-3 text-lg font-bold">{summary.seller ? verification[summary.seller.kycStatus] ?? 'Under Review' : 'Ready to start selling?'}</h2>
              <p className="mt-3 text-sm leading-relaxed text-[var(--ink-muted)]">{!summary.seller ? 'Start with an item. DASH will guide you through setting up your seller profile.'
                : summary.seller.kycStatus === 'verified' ? 'Your seller profile is verified. Every item still needs DASH review before it goes live.'
                : summary.seller.kycStatus === 'pending' ? 'DASH is reviewing your verification. You can submit items while you wait; publication requires approval.'
                : summary.seller.kycStatus === 'suspended' ? 'Contact DASH support about your seller status.'
                : 'Complete your seller verification before your items can go live.'}</p>
              {summary.seller && ['unverified', 'rejected'].includes(summary.seller.kycStatus) ? <Link href="/declutter/seller/verify" className={`${button} mt-5 w-full`}>{summary.seller.kycStatus === 'rejected' ? 'Update verification' : 'Verify seller profile'}</Link> : null}
              {summary.seller?.kycStatus === 'suspended' ? <a href="https://wa.me/2349112496182" className={`${button} mt-5 w-full`}>Contact DASH support</a> : null}
              {!summary.seller || summary.seller.canSubmit ? <Link href="/declutter/sell" className={`${button} mt-5 w-full bg-[var(--primary)] text-[var(--on-primary)]`}>Sell another item</Link> : null}
            </section> : null}
          </aside>
          <section className="min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-2xl font-bold">Your items</h2>
              <button type="button" onClick={() => setReload(n => n + 1)} className={button}>Refresh items</button>
            </div>
            {error ? <p role="alert" className="mt-5 text-sm text-[var(--danger)]">{error}</p> : !summary ? <p role="status" className="mt-5 text-sm text-[var(--ink-muted)]">Loading your items…</p>
              : rows.length === 0 ? <div className="dcl-glass mt-5 rounded-[var(--radius-card)] p-6"><h3 className="font-bold">No items yet</h3><p className="mt-2 text-sm text-[var(--ink-muted)]">When you submit an item, its progress will appear here.</p></div>
              : <div className="mt-5 space-y-6">{[...groups].map(([status, items]) => <section key={status} aria-label={status}>
                <h3 className="mb-3 text-sm font-bold">{status} <span className="text-[var(--ink-muted)]">({items.length})</span></h3>
                <div className="grid gap-3 sm:grid-cols-2">{items.map(({ submission, listing }) => <article key={submission?.id ?? listing!.id} className="dcl-glass min-w-0 rounded-[var(--radius-card)] p-5">
                  <p className="break-words font-bold">{listing?.title ?? submission?.title ?? submission?.code}</p>
                  {submission ? <p className="mt-2 text-xs text-[var(--ink-muted)]">{submission.code}</p> : null}
                  {listing ? <p className="mt-3 text-sm">{new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 }).format(listing.priceKobo / 100)}</p> : null}
                  <div className="mt-4 flex flex-wrap gap-3 text-sm font-bold">
                    {status === 'Live' && listing ? <Link href={`/declutter/${encodeURIComponent(listing.slug)}`} className="underline underline-offset-4">View listing</Link> : null}
                    {submission ? <Link href={`/declutter/sell#item-${encodeURIComponent(submission.id)}`} className="underline underline-offset-4">Manage item</Link> : null}
                  </div>
                </article>)}</div>
              </section>)}</div>}
          </section>
        </div>}
    </div>
  </main>;
}
