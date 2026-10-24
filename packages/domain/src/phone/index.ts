import { getCountries, getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import { z } from 'zod';

export { getCountries, getCountryCallingCode, type CountryCode };
export { countryNames } from './country-names.js';

/** Full numbering-plan metadata validates both length and assigned number patterns. */
export const e164PhoneSchema = z.string().trim().max(16).refine((value) => {
  if (!/^\+[1-9]\d{1,14}$/.test(value)) return false;
  const phone = parsePhoneNumberFromString(value, { extract: false });
  return !!phone?.isValid() && phone.number === value;
}, 'Enter a valid phone number for your country.');

/** Accept national formatting/trunk prefixes, but never an international dial prefix. */
export function nationalPhoneToE164(local: string, country: CountryCode): string | null {
  if (!/^[\d\s().-]+$/.test(local) || local.length > 40) return null;
  const phone = parsePhoneNumberFromString(local, { defaultCountry: country, extract: false });
  if (!phone || phone.countryCallingCode !== getCountryCallingCode(country) || phone.ext) return null;
  // Some territories share a complete numbering plan (e.g. Åland/Finland).
  // Validate against the selected country's metadata, rather than relying on
  // the country guessed by parsing. This still rejects wrong NANP area codes.
  phone.country = country;
  if (!phone.isValid()) return null;
  const digits = local.replace(/\D/g, '');
  // Parsing can also recognise an unprefixed country code. Accept only the
  // national number itself or its country's domestic formatted representation.
  if (digits !== phone.nationalNumber && digits !== phone.formatNational().replace(/\D/g, '')) return null;
  return phone.number;
}

export function splitPhone(value: string): { country: CountryCode; local: string } {
  const phone = parsePhoneNumberFromString(value, { extract: false });
  return phone?.country ? { country: phone.country, local: phone.formatNational() } : { country: 'NG', local: '' };
}
