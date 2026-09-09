'use client';

/**
 * Creating a DASH account.
 *
 * More than a name and an address, and every extra field earns its place: where
 * somebody is decides which items are near them, how they plan to use DASH
 * decides what the marketplace has to supply, and how they found it is the only
 * way to know which of DASH's efforts is working.
 *
 * The page is honest about which answers are checked. The email gets a code.
 * The phone is stored and not verified, and it says so rather than implying a
 * check that is not happening.
 *
 * **Nothing on this form grants anything.** Choosing "I sell regularly" is a
 * plan; selling still requires DASH to verify an identity, and the form says
 * that too so nobody signs up expecting to list something tonight.
 *
 * Age is an 18-or-older confirmation, not a date of birth. Terms and privacy
 * are one required acceptance. Marketing is a separate optional box that can
 * never block an account.
 */

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import {
  ACQUISITION_SOURCES,
  ACQUISITION_SOURCE_LABELS,
  acquisitionDetailPrompt,
  NIGERIAN_STATES,
  USAGE_INTENTS,
  USAGE_INTENT_LABELS,
  type AcquisitionSource,
} from '@dash/domain/signup';

import { AuthError, AuthField, AuthShell, AuthSubmit } from '@/components/declutter/AuthShell';
import { ApiRequestError } from '@/lib/api';
import { signUp } from '@/lib/session';
import { safeReturnTo } from '@/lib/return-to';

export function JoinPage() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeReturnTo(params.get('next'));

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [state, setState] = useState('');
  const [cityArea, setCityArea] = useState('');
  const [usageIntent, setUsageIntent] = useState('');
  const [acquisitionSource, setAcquisitionSource] = useState('');
  const [acquisitionDetail, setAcquisitionDetail] = useState('');
  const [confirmedAdult, setConfirmedAdult] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [marketingOptIn, setMarketingOptIn] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Revealed only where the answer would otherwise be useless: a referral with
  // no name is an attribution nobody can act on.
  const detailPrompt = acquisitionSource
    ? acquisitionDetailPrompt(acquisitionSource as AcquisitionSource)
    : null;

  const ready =
    name.trim().length >= 2 &&
    email.includes('@') &&
    /^\+\d{8,15}$/.test(phone.trim()) &&
    state !== '' &&
    cityArea.trim().length >= 2 &&
    usageIntent !== '' &&
    acquisitionSource !== '' &&
    (!detailPrompt || acquisitionDetail.trim().length >= 2) &&
    confirmedAdult &&
    acceptedTerms;

  return (
    <AuthShell
      eyebrow="Create account"
      title="One account for everything DASH."
      lede="The same account works on the Declutters marketplace and, later, in the DASH app. It takes about a minute."
      footer={
        <>
          Already have an account?{' '}
          <Link
            href={`/declutter/signin?next=${encodeURIComponent(next)}`}
            className="font-semibold text-[var(--ink)] underline"
          >
            Sign in
          </Link>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          void (async () => {
            try {
              const address = email.trim().toLowerCase();
              const result = await signUp({
                name: name.trim(),
                email: address,
                phone: phone.trim(),
                state,
                cityArea: cityArea.trim(),
                usageIntent,
                acquisitionSource,
                ...(detailPrompt ? { acquisitionDetail: acquisitionDetail.trim() } : {}),
                confirmedAdult: true,
                acceptedTerms: true,
                marketingOptIn,
              });

              const query = new URLSearchParams({ email: address, next });
              // Only outside production, and only when the API chose to return
              // one. Carried so local testing does not need a mail log.
              if (result.devCode) query.set('dev', result.devCode);
              router.push(`/declutter/verify?${query.toString()}`);
            } catch (caught) {
              setError(
                caught instanceof ApiRequestError
                  ? caught.message
                  : 'We could not create that account. Try again in a moment.',
              );
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        <div className="space-y-4">
          <AuthField
            id="join-name"
            label="Full name"
            autoComplete="name"
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Chinedu Okonkwo"
            hint="What a DASH team member will call you. It is never published on a listing."
          />
          <AuthField
            id="join-email"
            label="Email address"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            hint="We send a six-digit code here to confirm it is yours."
          />
          <AuthField
            id="join-phone"
            label="Phone number"
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            required
            value={phone}
            onChange={(event) => setPhone(event.target.value.replace(/[^\d+]/g, ''))}
            placeholder="+234 800 000 0000"
            // Said plainly. Implying a check that is not happening would be the
            // first thing this page got wrong.
            hint="Include the country code. We do not send a text — this is how DASH reaches you about an item."
          />

          <Select
            id="join-state"
            label="State"
            value={state}
            onChange={setState}
            placeholder="Select your state"
            options={NIGERIAN_STATES.map((value) => ({ value, label: value }))}
            hint="Every state, not only the ones DASH serves today."
          />

          <AuthField
            id="join-city"
            label="City, town or area"
            autoComplete="address-level2"
            required
            maxLength={80}
            value={cityArea}
            onChange={(event) => setCityArea(event.target.value)}
            placeholder="Yaba"
          />

          <Select
            id="join-usage"
            label="How do you plan to use DASH?"
            value={usageIntent}
            onChange={setUsageIntent}
            placeholder="Choose one"
            options={USAGE_INTENTS.map((value) => ({
              value,
              label: USAGE_INTENT_LABELS[value],
            }))}
            hint="Just so we know what to build. Selling is a separate step that DASH has to approve."
          />

          <Select
            id="join-source"
            label="How did you hear about us?"
            value={acquisitionSource}
            onChange={(value) => {
              setAcquisitionSource(value);
              setAcquisitionDetail('');
            }}
            placeholder="Choose one"
            options={ACQUISITION_SOURCES.map((value) => ({
              value,
              label: ACQUISITION_SOURCE_LABELS[value],
            }))}
          />

          {detailPrompt ? (
            <AuthField
              id="join-source-detail"
              label={detailPrompt}
              required
              maxLength={120}
              value={acquisitionDetail}
              onChange={(event) => setAcquisitionDetail(event.target.value)}
              placeholder="A name is enough"
            />
          ) : null}
        </div>

        <div className="mt-6 space-y-4 border-t border-[var(--line)] pt-6">
          <Check
            id="join-adult"
            checked={confirmedAdult}
            onChange={setConfirmedAdult}
            label="I confirm that I am 18 years or older."
          />

          <Check
            id="join-terms"
            checked={acceptedTerms}
            onChange={setAcceptedTerms}
            label={
              <>
                I accept the DASH World{' '}
                <Link href="/declutter/terms" className="underline">
                  Terms of Service
                </Link>{' '}
                and{' '}
                <Link href="/declutter/privacy" className="underline">
                  Privacy Policy
                </Link>
                .
              </>
            }
          />

          {/* Separate, optional, and off. Never a condition of holding an
              account — nothing anywhere refuses service on this box. */}
          <Check
            id="join-marketing"
            checked={marketingOptIn}
            onChange={setMarketingOptIn}
            label="Send me occasional emails about new items and DASH World news."
            hint="Optional. Your account works exactly the same either way, and you can stop at any time."
          />
        </div>

        <AuthError message={error} />

        <AuthSubmit disabled={busy || !ready}>{busy ? 'Creating…' : 'Create my account'}</AuthSubmit>

        <p className="mt-4 text-xs leading-relaxed text-[var(--ink-muted)]">
          Creating an account lets you ask about items. Selling is a separate step: DASH verifies
          your identity before anything of yours can be listed.
        </p>
      </form>
    </AuthShell>
  );
}

function Select({
  id,
  label,
  value,
  onChange,
  options,
  placeholder,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  placeholder: string;
  hint?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
      </label>
      <select
        id={id}
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 min-h-12 w-full rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)] px-4 text-sm text-[var(--ink)] outline-none focus:border-[var(--primary)]"
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {options.map((option) => (
          <option key={option.value} value={option.value} className="bg-[var(--surface-raised)]">
            {option.label}
          </option>
        ))}
      </select>
      {hint ? <p className="mt-1.5 text-xs text-[var(--ink-muted)]">{hint}</p> : null}
    </div>
  );
}

function Check({
  id,
  checked,
  onChange,
  label,
  hint,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex gap-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        // A 20px box with generous label spacing: a checkbox that is hard to
        // hit on a phone is a form people abandon at the last step.
        className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--primary)]"
      />
      <label htmlFor={id} className="text-sm leading-relaxed">
        {label}
        {hint ? <span className="mt-1 block text-xs text-[var(--ink-muted)]">{hint}</span> : null}
      </label>
    </div>
  );
}
