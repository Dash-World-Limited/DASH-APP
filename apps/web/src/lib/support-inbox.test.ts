/**
 * How the support centre names people, previews messages and builds its
 * requests.
 */

import { describe, expect, it } from 'vitest';

import { accountName, formatWhen, inboxPath, previewLine, roleLabel, threadPath, type SupportAccount } from './support-inbox';

const account: SupportAccount = {
  role: 'rider',
  identityId: 'id_1',
  profileId: 'rider_1',
  name: 'Ada Rider',
  email: 'ada@example.com',
  phone: '+2348000000001',
  accountStatus: 'active',
  riderStatus: 'approved',
};

describe('support inbox helpers', () => {
  it('asks for the filtered inbox and a single conversation', () => {
    expect(inboxPath('rider', 'open')).toBe('/v1/admin/support/conversations?audience=rider&status=open&limit=100');
    expect(inboxPath('all', 'all')).toBe('/v1/admin/support/conversations?audience=all&status=all&limit=100');
    expect(threadPath('case 1')).toBe('/v1/admin/support/conversations/case%201');
  });

  it('names the person by name, then email, then phone', () => {
    expect(accountName(account)).toBe('Ada Rider');
    expect(accountName({ ...account, name: '  ' })).toBe('ada@example.com');
    expect(accountName({ ...account, name: null, email: null })).toBe('+2348000000001');
    expect(accountName({ ...account, name: null, email: null, phone: null })).toBe('Rider account');
    expect(accountName(null)).toBe('Account no longer available');
    expect(roleLabel('customer')).toBe('Customer');
  });

  it('says who wrote last in the preview', () => {
    expect(previewLine({ lastMessage: { from: 'account', preview: 'Where is my order?', createdAt: '' } })).toBe('Where is my order?');
    expect(previewLine({ lastMessage: { from: 'staff', preview: 'On its way.', createdAt: '' } })).toBe('DASH: On its way.');
    expect(previewLine({ lastMessage: null })).toBe('No messages yet');
  });

  it('shows a time for today and a date otherwise', () => {
    const now = new Date(2026, 9, 14, 16, 0);
    expect(formatWhen(new Date(2026, 9, 14, 9, 5).toISOString(), now)).toMatch(/09.05|9.05/);
    expect(formatWhen(new Date(2026, 9, 2, 9, 5).toISOString(), now)).toMatch(/2/);
    expect(formatWhen(new Date(2026, 9, 2, 9, 5).toISOString(), now)).not.toMatch(/2026/);
    expect(formatWhen(new Date(2025, 0, 2).toISOString(), now)).toMatch(/2025/);
  });
});
