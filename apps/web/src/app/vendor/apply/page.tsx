'use client';

/**
 * Apply to sell on DASH.
 *
 * The first step of vendor onboarding: a signed-in person with a proved email
 * describes their business and store. The application grants nothing — the
 * founder approves each early vendor personally at /ops/partners, and only
 * then does the vendor console open. The phone number on the account is
 * shown with the server's own words: collected, not verified.
 *
 * The store's position comes from the browser, asked for only when the
 * applicant taps "Use this device's location" while standing at the store.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { AppHeader } from '@/components/AppHeader';
import { Button, Card, EmptyState, ErrorState, Field, Input } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { getFix } from '@/lib/geolocation';
import { authedFetch, useHasSession } from '@/lib/session';

const CATEGORIES = [
  { id: 'restaurant', label: 'Restaurant / food' },
  { id: 'grocery', label: 'Grocery' },
  { id: 'retail', label: 'Shop / retail' },
  { id: 'pharmacy', label: 'Pharmacy' },
  { id: 'market', label: 'Local market' },
] as const;

interface Application {
  vendorId: string;
  businessName: string;
  status: { code: string; label: string };
  reason: string | null;
}

interface PhoneStatus {
  number: string | null;
  notice: string | null;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return 'Something went wrong. Try again.';
}

export default function VendorApplyPage() {
  const signedIn = useHasSession();
  const [existing, setExisting] = useState<Application | null | undefined>(undefined);
  const [phone, setPhone] = useState<PhoneStatus | null>(null);
  const [cities, setCities] = useState<{ slug: string; name: string }[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [mine, me, cityList] = await Promise.all([
        authedFetch<{ application: Application }>('/v1/vendor/application').catch((error: unknown) => {
          if (error instanceof ApiRequestError && error.status === 404) return null;
          throw error;
        }),
        authedFetch<{ phone?: PhoneStatus }>('/v1/auth/me'),
        authedFetch<{ cities: { slug: string; name: string }[] }>('/v1/cities'),
      ]);
      setExisting(mine?.application ?? null);
      setPhone(me.phone ?? null);
      setCities(cityList.cities);
    } catch (error) {
      setLoadError(messageFor(error));
    }
  }, []);

  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn, load]);

  if (!signedIn) {
    return (
      <div className="min-h-dvh">
        <AppHeader />
        <main className="mx-auto max-w-xl px-4 py-10">
          <EmptyState
            title="Sign in to apply"
            description="Create a DASH account (or sign in) with the email you want to use for your store, then come back here."
            action={
              <Link href="/signin?next=/vendor/apply">
                <Button>Sign in</Button>
              </Link>
            }
          />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-dvh">
      <AppHeader />
      <main className="mx-auto max-w-xl space-y-6 px-4 py-8">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold">Sell on DASH</h1>
          <p className="text-sm text-[var(--ink-muted)]">
            Tell us about your business. Every early vendor is approved personally by the DASH team.
          </p>
        </header>
        {loadError ? <ErrorState message={loadError} onRetry={() => void load()} /> : null}
        {existing === undefined && !loadError ? <p className="text-sm text-[var(--ink-muted)]">Loading…</p> : null}
        {existing && existing.status.code !== 'rejected' ? (
          <Card className="space-y-2 p-6">
            <h2 className="text-lg font-bold">{existing.businessName}</h2>
            <p>
              Status: <strong>{existing.status.label}</strong>
            </p>
            {existing.status.code === 'approved' ? (
              <Link href="/vendor">
                <Button>Open the vendor console</Button>
              </Link>
            ) : (
              <p className="text-sm text-[var(--ink-muted)]">We will email you when it has been reviewed.</p>
            )}
            {existing.reason ? <p className="text-sm text-[var(--ink-muted)]">{existing.reason}</p> : null}
          </Card>
        ) : null}
        {existing === null || existing?.status.code === 'rejected' ? (
          <ApplicationForm cities={cities} phone={phone} previousReason={existing?.reason ?? null} onSubmitted={() => void load()} />
        ) : null}
      </main>
    </div>
  );
}

function ApplicationForm({
  cities,
  phone,
  previousReason,
  onSubmitted,
}: {
  cities: { slug: string; name: string }[];
  phone: PhoneStatus | null;
  previousReason: string | null;
  onSubmitted: () => void;
}) {
  const [businessName, setBusinessName] = useState('');
  const [category, setCategory] = useState<string>('');
  const [description, setDescription] = useState('');
  const [citySlug, setCitySlug] = useState('');
  const [address, setAddress] = useState('');
  const [storePhone, setStorePhone] = useState('');
  const [point, setPoint] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function locate() {
    setLocating(true);
    setNotice(null);
    const result = await getFix();
    setLocating(false);
    if (result.ok && result.fix) setPoint({ latitude: result.fix.latitude, longitude: result.fix.longitude });
    else setNotice(result.error ?? 'Your location could not be found. Allow location for this site and try again.');
  }

  const phoneOk = storePhone.trim() === '' || /^\+[1-9]\d{7,14}$/.test(storePhone.trim());
  const ready = businessName.trim().length >= 2 && category && citySlug && address.trim().length >= 5 && point && phoneOk;

  async function submit() {
    if (!ready || !point) return;
    setBusy(true);
    setNotice(null);
    try {
      await authedFetch('/v1/vendor/applications', {
        method: 'POST',
        body: {
          businessName: businessName.trim(),
          category,
          ...(description.trim() ? { description: description.trim() } : {}),
          citySlug,
          branch: {
            address: address.trim(),
            latitude: point.latitude,
            longitude: point.longitude,
            ...(storePhone.trim() ? { phone: storePhone.trim() } : {}),
          },
        },
      });
      onSubmitted();
    } catch (error) {
      setNotice(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 p-6">
      {previousReason ? <p className="text-sm text-[var(--ink-muted)]">Your last application was not approved: {previousReason}</p> : null}
      <Field label="Business name" htmlFor="business-name">
        <Input id="business-name" value={businessName} onChange={(e) => setBusinessName(e.target.value)} maxLength={80} />
      </Field>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">What do you sell?</legend>
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((option) => (
            <Button key={option.id} type="button" size="sm" variant={category === option.id ? 'primary' : 'ghost'} aria-pressed={category === option.id} onClick={() => setCategory(option.id)}>
              {option.label}
            </Button>
          ))}
        </div>
      </fieldset>
      <Field label="Short description (optional)" htmlFor="description">
        <Input id="description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
      </Field>
      <Field label="City" htmlFor="city">
        <select id="city" className="w-full rounded-xl border bg-[var(--surface-raised)] px-3.5 py-2.5" value={citySlug} onChange={(e) => setCitySlug(e.target.value)}>
          <option value="">Choose…</option>
          {cities.map((city) => (
            <option key={city.slug} value={city.slug}>
              {city.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Store address" htmlFor="address">
        <Input id="address" value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} />
      </Field>
      <div className="space-y-1">
        <Button type="button" variant="secondary" onClick={() => void locate()} disabled={locating}>
          {point ? 'Location captured — capture again' : locating ? 'Finding your location…' : "Use this device's location (stand at the store)"}
        </Button>
        <p className="text-xs text-[var(--ink-muted)]">Riders are sent to this point, so capture it at the store itself.</p>
      </div>
      <Field label="Store phone (optional)" htmlFor="store-phone" hint="With the country code, e.g. +234…" {...(!phoneOk ? { error: 'Include the country code, e.g. +234…' } : {})}>
        <Input id="store-phone" value={storePhone} onChange={(e) => setStorePhone(e.target.value)} inputMode="tel" />
      </Field>
      {phone?.number ? (
        <p className="text-sm text-[var(--ink-muted)]">
          Your account phone: {phone.number}
          {phone.notice ? ` — ${phone.notice}` : ''}
        </p>
      ) : null}
      {notice ? (
        <p role="alert" className="text-sm font-medium text-[var(--danger)]">
          {notice}
        </p>
      ) : null}
      <Button onClick={() => void submit()} disabled={!ready || busy}>
        {busy ? 'Sending…' : 'Submit application'}
      </Button>
    </Card>
  );
}
