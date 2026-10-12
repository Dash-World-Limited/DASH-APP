'use client';

import { useState } from 'react';
import { countryNames, getCountries, getCountryCallingCode, nationalPhoneToE164, splitPhone, type CountryCode } from '@dash/domain/phone';

const sortName = (name: string) => name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const countries = getCountries().map(code => ({ code, name: countryNames[code] }))
  .sort((a, b) => sortName(a.name) < sortName(b.name) ? -1 : sortName(a.name) > sortName(b.name) ? 1 : 0);
const inputClass = 'min-h-12 w-full min-w-0 rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)] px-3 text-sm text-[var(--ink)] outline-none focus:border-[var(--primary)] disabled:opacity-50';

/** Owns the editable national value; emits only valid E.164 or an empty invalid value. */
export function PhoneInput({ id, defaultValue = '', onChange, disabled = false, hint }: {
  id: string; defaultValue?: string; onChange: (e164: string) => void; disabled?: boolean; hint?: string;
}) {
  const [initial] = useState(() => splitPhone(defaultValue));
  const [country, setCountry] = useState<CountryCode>(initial.country);
  const [local, setLocal] = useState(initial.local);
  const [touched, setTouched] = useState(false);
  const valid = nationalPhoneToE164(local, country);
  const error = touched && !valid;
  return <fieldset className="min-w-0 space-y-2" disabled={disabled}>
    <legend className="text-sm font-semibold">Phone number</legend>
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <div className="min-w-0">
        <label htmlFor={`${id}-country`} className="mb-1.5 block text-xs text-[var(--ink-muted)]">Country</label>
        <select id={`${id}-country`} className={inputClass} value={country} onChange={event => {
          const next = event.target.value as CountryCode;
          setCountry(next);
          if (local) setTouched(true);
          onChange(nationalPhoneToE164(local, next) ?? '');
        }}>
          {countries.map(({ code, name }) => <option key={code} value={code}>{name} (+{getCountryCallingCode(code)})</option>)}
        </select>
      </div>
      <div className="min-w-0">
        <label htmlFor={id} className="mb-1.5 block text-xs text-[var(--ink-muted)]">Local phone number</label>
        <input id={id} type="tel" inputMode="tel" autoComplete="tel-national" required maxLength={40}
          className={inputClass} value={local} aria-invalid={error} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
          onBlur={() => setTouched(true)} onChange={event => {
            const next = event.target.value;
            setLocal(next);
            onChange(nationalPhoneToE164(next, country) ?? '');
          }} />
      </div>
    </div>
    <p id={`${id}-hint`} className="text-xs leading-relaxed text-[var(--ink-muted)]">Enter your local number, including the area code where needed. Country code +{getCountryCallingCode(country)} is added automatically. {hint}</p>
    {error ? <p id={`${id}-error`} role="alert" className="text-xs text-[var(--danger)]">Enter a valid local number for {countryNames[country]}, without the country code.</p> : null}
  </fieldset>;
}
