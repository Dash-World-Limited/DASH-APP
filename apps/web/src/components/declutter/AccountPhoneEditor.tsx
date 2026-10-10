'use client';

import { useState } from 'react';
import { e164PhoneSchema } from '@dash/domain/phone';
import { PhoneInput } from '@/components/PhoneInput';
import { ApiRequestError } from '@/lib/api';
import { authedFetch, invalidateMe } from '@/lib/session';

export function AccountPhoneEditor({ initialPhone }: { initialPhone: string | null }) {
  const [editing, setEditing] = useState(false);
  const [savedPhone, setSavedPhone] = useState(initialPhone ?? '');
  const [phone, setPhone] = useState(savedPhone);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const button = 'min-h-11 rounded-full border border-[var(--line-strong)] px-4 text-sm font-bold disabled:opacity-50';
  if (!editing) return <div className="mt-5">
    <button type="button" className={`${button} w-full`} onClick={() => { setPhone(savedPhone); setError(null); setMessage(null); setEditing(true); }}>Edit contact number</button>
    {message ? <p role="status" className="mt-2 text-xs text-[var(--ink-muted)]">{message}</p> : null}
  </div>;
  return <form className="mt-5 space-y-3" onSubmit={event => {
    event.preventDefault();
    if (busy || !e164PhoneSchema.safeParse(phone).success) return;
    setBusy(true); setError(null);
    void authedFetch('/v1/account/phone', { method: 'PATCH', body: { phone } }).then(() => {
      invalidateMe();
      setSavedPhone(phone); setMessage('Contact number saved. Phone numbers are not verified by SMS.'); setEditing(false);
    }).catch(caught => setError(caught instanceof ApiRequestError ? caught.message : 'Could not save your number. Please try again.'))
      .finally(() => setBusy(false));
  }}>
    <PhoneInput id="account-phone" defaultValue={savedPhone} onChange={setPhone} disabled={busy} hint="This updates your account contact number. Seller verification details are handled separately." />
    {error ? <p role="alert" className="text-sm text-[var(--danger)]">{error}</p> : null}
    <div className="flex flex-wrap gap-2">
      <button type="submit" disabled={busy || !e164PhoneSchema.safeParse(phone).success} className={`${button} bg-[var(--primary)] text-[var(--on-primary)]`}>{busy ? 'Saving…' : 'Save number'}</button>
      <button type="button" disabled={busy} className={button} onClick={() => setEditing(false)}>Cancel</button>
    </div>
  </form>;
}
