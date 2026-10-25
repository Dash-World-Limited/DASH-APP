import { describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, ROLES } from '../permissions/index.js';
import { contentIsVisible, contentSchema } from './index.js';
describe('Studio policy', () => {
  it('grants draft management to editors and Super Admin, with publication reserved for Super Admin', () => {
    expect(
      ROLES.filter((role) => ROLE_PERMISSIONS[role].includes('content:manage')),
    ).toEqual(['content_editor', 'super_admin']);
    expect(ROLES.filter((role) => ROLE_PERMISSIONS[role].includes('content:publish'))).toEqual(['super_admin']);
  });
  it('uses inclusive start and exclusive end schedule boundaries', () => {
    const data = contentSchema.parse({
      internalName: 'Test',
      type: 'announcement',
      placement: 'home.announcements',
      title: 'Test',
      startsAt: '2026-10-25T10:00:00Z',
      endsAt: '2026-10-25T11:00:00Z',
    });
    expect(contentIsVisible(data, new Date('2026-10-25T09:59:59Z'))).toBe(
      false,
    );
    expect(contentIsVisible(data, new Date(data.startsAt!))).toBe(true);
    expect(contentIsVisible(data, new Date(data.endsAt!))).toBe(false);
  });
});
