import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { API_BASE } from '@/lib/api';
import { INDEXING_ENABLED, SITE_ORIGIN } from '@/lib/declutter';

/**
 * Privacy Policy.
 *
 * Rendered from the same `LegalDocument` row that acceptance points at, so the
 * page a person reads before ticking the box is the text their acceptance
 * records. A policy page maintained separately from the accepted version is one
 * that eventually disagrees with the evidence.
 *
 * Server-rendered and uncached: publishing a new version has to take effect
 * immediately, and a stale policy is the one kind of stale page that matters.
 */

const SLUG = 'privacy-policy';

interface LegalDocument {
  slug: string;
  version: string;
  title: string;
  body: string;
  effectiveFrom: string;
}

async function fetchDocument(): Promise<LegalDocument | null> {
  try {
    const response = await fetch(`${API_BASE}/v1/legal/${SLUG}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const body = (await response.json()) as { document: LegalDocument };
    return body.document;
  } catch {
    return null;
  }
}

export const metadata: Metadata = {
  title: 'Privacy Policy — DASH World',
  description: 'What DASH World Limited collects, what it verifies, and what it publishes.',
  alternates: { canonical: `${SITE_ORIGIN}/declutter/privacy` },
  robots: INDEXING_ENABLED ? { index: true, follow: true } : { index: false, follow: false },
};

export default async function Page() {
  const document = await fetchDocument();
  if (!document) notFound();

  return (
    <main id="main" className="mx-auto w-full max-w-3xl px-5 py-16 sm:px-8 sm:py-20">
      <p className="dcl-eyebrow">Legal</p>
      <h1 className="dcl-display mt-4 text-3xl sm:text-4xl">{document.title}</h1>
      <p className="mt-4 text-sm text-[var(--ink-muted)]">
        Version {document.version} · in effect from{' '}
        {new Date(document.effectiveFrom).toLocaleDateString('en-NG', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })}
      </p>

      {/* Whitespace preserved: the stored body is plain text, and turning it
          into markup here would mean two places decide what it says. */}
      <div className="mt-10 whitespace-pre-line text-sm leading-relaxed text-[var(--ink-muted)]">
        {document.body}
      </div>
    </main>
  );
}
