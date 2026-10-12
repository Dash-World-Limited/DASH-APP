import { expect, it } from 'vitest';
import { getExampleNumber } from 'libphonenumber-js/max';
import examples from 'libphonenumber-js/examples.mobile.json';
import { e164PhoneSchema, getCountries, nationalPhoneToE164, splitPhone } from './index.js';

it.each([
  ['NG', '0801 234 5678', '+2348012345678'],
  ['GB', '07400 123456', '+447400123456'],
  ['US', '(202) 555-0123', '+12025550123'],
  ['CA', '416 555 0123', '+14165550123'],
  ['IT', '02 3661 8300', '+390236618300'],
  ['IN', '9123456789', '+919123456789'],
] as const)('converts %s national numbers including country-specific trunk prefixes', (country, local, e164) => {
  expect(nationalPhoneToE164(local, country)).toBe(e164);
  expect(e164PhoneSchema.safeParse(e164).success).toBe(true);
  const split = splitPhone(e164);
  expect(split.country).toBe(country);
  expect(nationalPhoneToE164(split.local, split.country)).toBe(e164);
});

it.each(['', '0801', '00000000000', '08012345678999', '+2348012345678', '2348012345678', '002348012345678', 'call 08012345678', '08012345678 ext 12'])('rejects invalid or international input %s', value => {
  expect(nationalPhoneToE164(value, 'NG')).toBeNull();
});

it('rejects a valid number belonging to another country sharing the calling code', () => {
  expect(nationalPhoneToE164('4165550123', 'US')).toBeNull();
  expect(nationalPhoneToE164('2025550123', 'CA')).toBeNull();
});

it('supports every country in the numbering metadata with its national example', () => {
  expect(getCountries().length).toBeGreaterThan(240);
  for (const country of getCountries()) {
    const phone = getExampleNumber(country, examples);
    expect(phone, country).toBeDefined();
    expect(nationalPhoneToE164(phone!.formatNational(), country), country).toBe(phone!.number);
  }
});

it.each(['+2340000000000', '+12020000000', '+234801', '08012345678', '+2348012345678 ext 1'])('also rejects malformed API E.164 %s', phone => {
  expect(e164PhoneSchema.safeParse(phone).success).toBe(false);
});
