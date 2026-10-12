/**
 * The Rider Home header shows the rider's own first name and nothing else.
 * These tests pin the two things that would embarrass the app: greeting
 * somebody by a name that is not theirs, and greeting nobody at all with a
 * placeholder that looks like a real rider.
 */

import { describe, expect, it } from 'vitest';

import type { Viewer } from './AppSessionProvider';
import { viewerFirstName, viewerInitials } from './viewerName';

function viewer(displayName: string | null, rest: Partial<Viewer['identity']> = {}): Viewer {
  return {
    identity: { id: 'u1', phone: null, email: null, displayName, locale: 'en-NG', ...rest },
    roles: ['rider'],
    permissions: [],
    customerId: null,
    riderId: 'r1',
    riderStatus: 'approved',
    riderAvailability: 'offline',
  };
}

describe('viewerFirstName', () => {
  it('takes the first word of the display name', () => {
    expect(viewerFirstName(viewer('Adaeze Okonkwo'))).toBe('Adaeze');
  });

  it('keeps a single-word name whole', () => {
    expect(viewerFirstName(viewer('Emeka'))).toBe('Emeka');
  });

  it('takes only the first of several names', () => {
    expect(viewerFirstName(viewer('Chukwuemeka Obiora Nwosu'))).toBe('Chukwuemeka');
  });

  it('ignores surrounding and repeated whitespace', () => {
    expect(viewerFirstName(viewer('   Ngozi    Bello  '))).toBe('Ngozi');
  });

  it('is null when there is no viewer, so a signed-out header shows no name', () => {
    expect(viewerFirstName(null)).toBeNull();
  });

  it('is null when the server has no name for the profile', () => {
    expect(viewerFirstName(viewer(null))).toBeNull();
  });

  it('is null when the name is blank rather than absent', () => {
    expect(viewerFirstName(viewer('   '))).toBeNull();
  });

  it('never falls back to an email or a phone number', () => {
    expect(viewerFirstName(viewer(null, { email: 'ada@example.com', phone: '+2348030000000' }))).toBeNull();
  });
});

describe('viewerInitials', () => {
  it('takes one letter from each of the first two names', () => {
    expect(viewerInitials(viewer('Adaeze Okonkwo'))).toBe('AO');
  });

  it('takes a single letter from a single-word name', () => {
    expect(viewerInitials(viewer('Emeka'))).toBe('E');
  });

  it('stops at two letters however many names there are', () => {
    expect(viewerInitials(viewer('Chukwuemeka Obiora Nwosu'))).toBe('CO');
  });

  it('is null when the name is unknown', () => {
    expect(viewerInitials(null)).toBeNull();
    expect(viewerInitials(viewer(null))).toBeNull();
  });
});
