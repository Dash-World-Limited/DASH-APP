'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { ApiRequestError } from '@/lib/api';
import { authedFetch, useHasSession } from '@/lib/session';
import { signInHref } from '@/lib/return-to';

type KycStatus = 'unverified' | 'pending' | 'verified' | 'rejected' | 'suspended';

type DocumentKind = 'national_id' | 'drivers_licence' | 'passport' | 'voters_card';

interface SellerSelf {
  id: string;
  displayName: string;
  publicArea: string | null;
  kycStatus: KycStatus;
  rejectionReason: string | null;
}

const DOCUMENT_LABELS: Record<DocumentKind, string> = {
  national_id: 'National ID / NIN document',
  drivers_licence: "Driver's licence",
  passport: 'International passport',
  voters_card: "Voter's card",
};

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_FILE_BYTES = 8 * 1024 * 1024;

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('file_read_failed'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') return reject(new Error('file_read_failed'));
      const comma = result.indexOf(',');
      if (comma < 0) return reject(new Error('file_read_failed'));
      resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-bold">
        {label}
      </label>
      {hint ? <p className="mt-1 text-xs leading-relaxed text-[var(--ink-muted)]">{hint}</p> : null}
      <div className="mt-2">{children}</div>
    </div>
  );
}

const inputClass =
  'min-h-12 w-full rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)] px-4 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)] focus:border-[var(--primary)]';

export function SellerVerificationPage() {
  const hasSession = useHasSession();
  const [seller, setSeller] = useState<SellerSelf | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [legalName, setLegalName] = useState('');
  const [identityName, setIdentityName] = useState('');
  const [nationalId, setNationalId] = useState('');
  const [phoneE164, setPhoneE164] = useState('');
  const [addressLine, setAddressLine] = useState('');
  const [documentKind, setDocumentKind] = useState<DocumentKind>('national_id');
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!hasSession) {
        if (!cancelled) setLoaded(true);
        return;
      }

      try {
        const data = await authedFetch<{ seller: SellerSelf }>('/v1/declutter/seller/me');
        if (!cancelled) setSeller(data.seller);
      } catch (caught) {
        if (!cancelled) {
          if (caught instanceof ApiRequestError && caught.status === 404) {
            setSeller(null);
          } else {
            setLoadError(
              caught instanceof ApiRequestError
                ? caught.message
                : 'We could not load your seller profile.',
            );
          }
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [hasSession]);

  async function submit() {
    if (!documentFile) {
      setError('Choose a government ID document to upload.');
      return;
    }
    if (!ALLOWED_TYPES.has(documentFile.type)) {
      setError('Use a JPEG, PNG, WebP or PDF document.');
      return;
    }
    if (documentFile.size > MAX_FILE_BYTES) {
      setError('The document must be smaller than 8 MB.');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const data = await fileToBase64(documentFile);

      // Store the evidence first. If the later details request fails, the
      // seller can retry without losing the private document they already sent.
      await authedFetch('/v1/declutter/seller/me/documents', {
        method: 'POST',
        body: {
          kind: documentKind,
          contentType: documentFile.type,
          data,
        },
      });

      const result = await authedFetch<{ seller: SellerSelf }>(
        '/v1/declutter/seller/me/verification',
        {
          method: 'POST',
          body: {
            legalName: legalName.trim(),
            identityName: identityName.trim(),
            nationalId: nationalId.trim(),
            phoneE164: phoneE164.trim(),
            addressLine: addressLine.trim(),
          },
        },
      );

      setSeller(result.seller);
      setSubmitted(true);
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'We could not submit your verification. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  const ready =
    legalName.trim().length >= 2 &&
    identityName.trim().length >= 2 &&
    nationalId.trim().length >= 6 &&
    /^\+[1-9]\d{7,14}$/.test(phoneE164.trim()) &&
    addressLine.trim().length >= 4 &&
    documentFile !== null &&
    confirmed;

  return (
    <main id="main">
      <section className="border-b border-[var(--line)]">
        <div className="mx-auto w-full max-w-[900px] px-5 py-14 sm:px-8 sm:py-16">
          <p className="dcl-eyebrow">Seller verification</p>
          <h1 className="dcl-display mt-4 text-3xl sm:text-4xl">Verify once. Sell with confidence.</h1>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-[var(--ink-muted)] sm:text-base">
            DASH reviews seller identity before an item can go live. Your legal name, ID number,
            phone and address are private and are never shown on the marketplace.
          </p>
        </div>
      </section>

      <div className="mx-auto w-full max-w-[900px] px-5 py-10 sm:px-8 sm:py-14">
        {!loaded ? (
          <div className="dcl-glass rounded-[var(--radius-card)] p-6">
            <p className="text-sm text-[var(--ink-muted)]">Checking your seller profile…</p>
          </div>
        ) : loadError ? (
          <div role="alert" className="rounded-[var(--radius-card)] border border-[var(--danger)] bg-[var(--danger-soft)] p-6">
            <p className="font-bold text-[var(--danger)]">Could not load your profile</p>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">{loadError}</p>
          </div>
        ) : !hasSession ? (
          <div className="dcl-glass rounded-[var(--radius-card)] p-6 sm:p-8">
            <h2 className="text-xl font-bold">Sign in first</h2>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">
              Verification belongs to your DASH account so you only complete it once.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href={signInHref('/declutter/seller/verify')}
                className="inline-flex min-h-12 items-center rounded-full bg-[var(--primary)] px-6 text-sm font-bold text-[var(--on-primary)]"
              >
                Sign in
              </Link>
              <Link
                href="/declutter/join?next=%2Fdeclutter%2Fseller%2Fverify"
                className="inline-flex min-h-12 items-center rounded-full border border-[var(--line-strong)] px-6 text-sm font-bold"
              >
                Create account
              </Link>
            </div>
          </div>
        ) : !seller ? (
          <div className="dcl-glass rounded-[var(--radius-card)] p-6 sm:p-8">
            <h2 className="text-xl font-bold">Start your seller profile first</h2>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">
              Tell us the display name and area buyers may see, then come back here to verify privately.
            </p>
            <Link
              href="/declutter/sell"
              className="mt-6 inline-flex min-h-12 items-center rounded-full bg-[var(--primary)] px-6 text-sm font-bold text-[var(--on-primary)]"
            >
              Start selling
            </Link>
          </div>
        ) : seller.kycStatus === 'verified' ? (
          <StatusPanel
            title="You're verified"
            body="Your seller identity has been approved. You do not need to upload ID again for every item."
          />
        ) : seller.kycStatus === 'pending' || submitted ? (
          <StatusPanel
            title="Verification received"
            body="Your details are safely with DASH for review. You can still submit an item while we review them; it simply cannot go live until you are approved."
          />
        ) : seller.kycStatus === 'suspended' ? (
          <StatusPanel
            title="Seller verification is unavailable"
            body="Selling is currently paused on this account. Contact DASH support if you need help."
          />
        ) : (
          <div className="dcl-glass rounded-[var(--radius-card)] p-6 sm:p-8">
            {seller.kycStatus === 'rejected' && seller.rejectionReason ? (
              <div className="mb-7 rounded-xl border border-[var(--danger)] bg-[var(--danger-soft)] p-4">
                <p className="text-sm font-bold text-[var(--danger)]">We need you to correct something</p>
                <p className="mt-1 text-sm text-[var(--ink-muted)]">{seller.rejectionReason}</p>
              </div>
            ) : null}

            <div className="grid gap-6 sm:grid-cols-2">
              <Field id="legal-name" label="Legal name" hint="Your full name as it appears on your government ID.">
                <input
                  id="legal-name"
                  className={inputClass}
                  value={legalName}
                  maxLength={120}
                  autoComplete="name"
                  onChange={(event) => setLegalName(event.target.value)}
                />
              </Field>

              <Field id="identity-name" label="Name on ID" hint="Type it exactly as printed on the document you are uploading.">
                <input
                  id="identity-name"
                  className={inputClass}
                  value={identityName}
                  maxLength={120}
                  onChange={(event) => setIdentityName(event.target.value)}
                />
              </Field>

              <Field id="national-id" label="ID number" hint="Stored encrypted. It is never displayed publicly.">
                <input
                  id="national-id"
                  className={inputClass}
                  value={nationalId}
                  maxLength={32}
                  autoComplete="off"
                  onChange={(event) => setNationalId(event.target.value)}
                />
              </Field>

              <Field id="seller-phone" label="Phone number" hint="A number DASH can reach you on. Include +234 or your country code.">
                <input
                  id="seller-phone"
                  className={inputClass}
                  value={phoneE164}
                  type="tel"
                  autoComplete="tel"
                  placeholder="+234…"
                  onChange={(event) => setPhoneE164(event.target.value)}
                />
              </Field>
            </div>

            <div className="mt-6">
              <Field id="seller-address" label="Private address" hint="For seller verification only. Buyers never see this address.">
                <textarea
                  id="seller-address"
                  className={`${inputClass} min-h-24 py-3`}
                  value={addressLine}
                  maxLength={200}
                  autoComplete="street-address"
                  onChange={(event) => setAddressLine(event.target.value)}
                />
              </Field>
            </div>

            <div className="mt-8 border-t border-[var(--line)] pt-7">
              <h2 className="text-base font-bold">Government ID</h2>
              <p className="mt-1 text-xs leading-relaxed text-[var(--ink-muted)]">
                Upload one clear ID document. It is stored privately and only authorised DASH reviewers can open it.
              </p>

              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                <Field id="document-kind" label="Document type">
                  <select
                    id="document-kind"
                    className={inputClass}
                    value={documentKind}
                    onChange={(event) => setDocumentKind(event.target.value as DocumentKind)}
                  >
                    {Object.entries(DOCUMENT_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field id="identity-document" label="ID file" hint="JPEG, PNG, WebP or PDF · maximum 8 MB">
                  <input
                    id="identity-document"
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    className="block min-h-12 w-full rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)] px-3 py-3 text-sm file:mr-3 file:rounded-full file:border-0 file:bg-[var(--primary)] file:px-4 file:py-2 file:text-xs file:font-bold file:text-[var(--on-primary)]"
                    onChange={(event) => setDocumentFile(event.target.files?.[0] ?? null)}
                  />
                </Field>
              </div>
            </div>

            <label className="mt-7 flex cursor-pointer items-start gap-3 rounded-xl border border-[var(--line)] p-4">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                className="mt-1 h-4 w-4"
              />
              <span className="text-sm leading-relaxed text-[var(--ink-muted)]">
                I confirm these details are mine, the document is genuine, and DASH may use them only to verify my seller identity and protect marketplace transactions.
              </span>
            </label>

            {error ? (
              <p role="alert" className="mt-5 text-sm font-semibold text-[var(--danger)]">
                {error}
              </p>
            ) : null}

            <button
              type="button"
              disabled={!ready || busy}
              onClick={() => void submit()}
              className="mt-7 min-h-12 w-full rounded-full bg-[var(--primary)] px-7 text-sm font-bold text-[var(--on-primary)] transition-colors hover:bg-[var(--primary-hover)] disabled:opacity-50"
            >
              {busy ? 'Submitting securely…' : 'Submit for verification'}
            </button>

            <p className="mt-4 text-center text-xs leading-relaxed text-[var(--ink-muted)]">
              Verification does not publish an item. Every listing still goes through DASH review before it appears publicly.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

function StatusPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="dcl-glass rounded-[var(--radius-card)] p-6 sm:p-8">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--primary-soft)] text-lg font-black text-[var(--primary)]">
        ✓
      </div>
      <h2 className="mt-5 text-xl font-bold">{title}</h2>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-[var(--ink-muted)]">{body}</p>
      <Link
        href="/declutter/sell"
        className="mt-6 inline-flex min-h-12 items-center rounded-full bg-[var(--primary)] px-6 text-sm font-bold text-[var(--on-primary)]"
      >
        Back to selling
      </Link>
    </div>
  );
}
