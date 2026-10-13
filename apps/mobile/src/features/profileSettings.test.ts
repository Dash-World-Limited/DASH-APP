import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NOTIFICATIONS_ENABLED,
  notificationPreferenceKey,
  parseNotificationPreference,
  readNotificationPreference,
  writeNotificationPreference,
} from './notificationPreference';
import { formFromProfile, hasChanges, personalDetailsChanges, personalDetailsProblems, type ProfileEditable } from './personalDetails';
import { DASH_SUPPORT_EMAIL, SUPPORT_CHANNELS, supportMailto, whatsappUrl } from './support';

function memoryStore() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe('notification preference', () => {
  it('is on until someone turns it off', async () => {
    expect(DEFAULT_NOTIFICATIONS_ENABLED).toBe(true);
    expect(await readNotificationPreference(memoryStore(), 'id-1')).toBe(true);
  });

  it('survives a reopen: what was written is what is read back', async () => {
    const store = memoryStore();
    await writeNotificationPreference(store, 'id-1', false);
    expect(await readNotificationPreference(store, 'id-1')).toBe(false);
    await writeNotificationPreference(store, 'id-1', true);
    expect(await readNotificationPreference(store, 'id-1')).toBe(true);
  });

  it('keeps each account’s choice separate on a shared phone', async () => {
    const store = memoryStore();
    await writeNotificationPreference(store, 'id-1', false);
    expect(await readNotificationPreference(store, 'id-2')).toBe(true);
    expect(notificationPreferenceKey('id-1')).not.toBe(notificationPreferenceKey('id-2'));
    expect(notificationPreferenceKey(null)).toBe('dash.notifications.v1');
  });

  it('reads anything but an explicit off as the default', () => {
    expect(parseNotificationPreference('off')).toBe(false);
    for (const junk of [null, undefined, '', 'OFF', 'false', 0, {}]) expect(parseNotificationPreference(junk), String(junk)).toBe(true);
  });
});

describe('personal details', () => {
  const all: ProfileEditable = { name: true, phone: true, location: true };
  const initial = formFromProfile({ name: 'Ada Obi', email: 'ada@example.com', phone: '+2348012345678', phoneNotice: null, state: 'Delta', cityArea: 'Asaba' });

  it('sends nothing when nothing changed, whitespace included', () => {
    const changes = personalDetailsChanges(initial, { ...initial, name: ' Ada Obi ', phone: '+234 801 234 5678' }, all);
    expect(hasChanges(changes)).toBe(false);
  });

  it('splits profile fields from the phone, which keeps its own route', () => {
    const changes = personalDetailsChanges(initial, { ...initial, name: 'Ada N. Obi', cityArea: 'Okpanam', phone: '+234 803 000 0000' }, all);
    expect(changes).toEqual({ profile: { name: 'Ada N. Obi', cityArea: 'Okpanam' }, phone: '+2348030000000' });
  });

  it('never sends a field the server will not let this account edit', () => {
    const changes = personalDetailsChanges(initial, { name: 'New', phone: '+2348030000000', state: 'Lagos', cityArea: 'Yaba' }, { name: true, phone: false, location: false });
    expect(changes).toEqual({ profile: { name: 'New' } });
  });

  it('applies sign-up’s rules to what changed', () => {
    const problems = personalDetailsProblems(initial, { name: 'A', phone: '0803 000 0000', state: 'Atlantis', cityArea: ' ' }, all);
    expect(Object.keys(problems).sort()).toEqual(['cityArea', 'name', 'phone', 'state']);
    expect(personalDetailsProblems(initial, { ...initial, name: 'x'.repeat(81) }, all).name).toBe('Use 80 characters or fewer');
  });

  it('lets an older account with no state fix just its name', () => {
    const legacy = formFromProfile({ name: 'Ola', email: null, phone: null, phoneNotice: null, state: null, cityArea: null });
    expect(personalDetailsProblems(legacy, { ...legacy, name: 'Ola Bello' }, all)).toEqual({});
  });
});

describe('support', () => {
  it('reaches DASH at the official support address, and nowhere invented', () => {
    expect(DASH_SUPPORT_EMAIL).toBe('info@dashworldng.com');
    expect(SUPPORT_CHANNELS).toEqual([{ kind: 'email', address: 'info@dashworldng.com' }]);
  });

  it('opens an email that already says who is writing', () => {
    const url = supportMailto(DASH_SUPPORT_EMAIL, 'rider', 'rider@example.com');
    expect(url.startsWith('mailto:info@dashworldng.com?subject=')).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('subject')).toBe('DASH App help (Rider)');
    expect(params.get('body')).toContain('Order code');
    expect(params.get('body')).toContain('Account: rider@example.com');
    expect(new URLSearchParams(supportMailto(DASH_SUPPORT_EMAIL, 'customer').split('?')[1]).get('body')).not.toContain('Account:');
  });

  it('builds a WhatsApp link from an E.164 number', () => {
    expect(whatsappUrl('+234 801 234 5678')).toBe('https://wa.me/2348012345678');
  });
});
