'use client';

/**
 * Creating a DASH account.
 *
 * Three fields, because three is what the account needs: a name to put on an
 * enquiry, an email to prove, and a phone number so a DASH team member can
 * arrange an introduction by the means most people in Lagos and Asaba actually
 * answer.
 *
 * The page is honest about which of those is checked. The email gets a code;
 * the phone is stored and not verified, and saying so is better than implying a
 * check that is not happening.
 *
 * On success it moves to the verify page carrying the address, and nothing
 * else. It never says whether the address was already registered — the API
 * answers identically either way, deliberately, and a form that revealed the
 * difference would hand anybody with a list of addresses a membership oracle.
 */

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = name.trim().length >= 2 && email.includes('@') && /^\+\d{8,15}$/.test(phone.trim());

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
            label="Your name"
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
