/**
 * Mode is presentation. Approval is the server's.
 *
 * The failure this suite guards against is the tempting one: letting a
 * remembered preference, a role, or the mere existence of a rider profile
 * decide that someone may work. Each of those is available to the client and
 * none of them is authority. `riderStatus === 'approved'` is the only thing
 * that opens rider mode, it comes from `/v1/auth/me`, and it is recomputed on
 * every hydration — so a rider suspended overnight reopens as a customer.
 *
 * None of this grants access. The rider routes authorise against the caller's
 * own identity server-side and refuse a customer-only account whatever the app
 * believes, which is asserted in the API suite. This is the client half:
 * an option nobody is allowed to use should not be shown in the first place.
 */

import { describe, expect, it } from 'vitest';

import type { Me } from './api';
import { canUseRiderMode, homeFor, resolveMode, type AppMode } from './mode';

const asMe = (over: Partial<Me>): Me =>
  ({
    identity: { id: 'i1', displayName: 'Test', email: null, phone: null },
    roles: ['customer'],
    permissions: [],
    vendorId: null,
    riderId: null,
    riderAvailability: null,
    riderStatus: null,
    customerId: 'c1',
    cityIds: [],
    ...over,
  }) as unknown as Me;

describe('canUseRiderMode', () => {
  it('opens rider mode only for an approved rider', () => {
    expect(canUseRiderMode(asMe({ riderId: 'r1', riderStatus: 'approved' }))).toBe(true);
  });

  it('refuses every other rider status, all of which still have a riderId', () => {
    // The reason `riderStatus` exists at all. Gating on `riderId` would offer
    // rider mode to an account the server refuses at every turn, which reads
    // as a broken app rather than as an unapproved one.
    for (const status of ['pending', 'suspended', 'rejected'] as const) {
      expect(canUseRiderMode(asMe({ riderId: 'r1', riderStatus: status })), status).toBe(false);
    }
  });

  it('refuses an account with no rider profile', () => {
    expect(canUseRiderMode(asMe({}))).toBe(false);
  });

  it('refuses when there is no session at all', () => {
    expect(canUseRiderMode(null)).toBe(false);
  });

  it('is not swayed by roles', () => {
    // A `rider` role without an approved profile is not permission to work.
    expect(canUseRiderMode(asMe({ roles: ['customer', 'rider'], riderId: 'r1' }))).toBe(false);
  });
});

describe('resolveMode', () => {
  const approved = asMe({ riderId: 'r1', riderStatus: 'approved' });

  it('honours a remembered rider mode for an approved rider', () => {
    expect(resolveMode(approved, 'rider')).toBe('rider');
  });

  it('ignores a remembered rider mode when the server does not approve', () => {
    // The forged-preference case: someone edits local storage, or an approval
    // is withdrawn between sessions. Either way the app opens as a customer.
    for (const status of ['pending', 'suspended', 'rejected', null] as const) {
      expect(resolveMode(asMe({ riderId: 'r1', riderStatus: status }), 'rider'), String(status)).toBe(
        'customer',
      );
    }
  });

  it('falls back to customer for a signed-out session', () => {
    expect(resolveMode(null, 'rider')).toBe('customer');
  });

  it('defaults to customer when nothing is remembered', () => {
    // Customer is the base identity: the app opens as a shop unless a rider
    // deliberately left it in rider mode.
    expect(resolveMode(approved, null)).toBe('customer');
  });

  it('never resolves to a mode the account cannot use', () => {
    const everyRemembered: (AppMode | null)[] = ['customer', 'rider', null];
    for (const remembered of everyRemembered) {
      expect(resolveMode(asMe({}), remembered), String(remembered)).toBe('customer');
    }
  });
});

describe('homeFor', () => {
  it('sends each mode to its own landing route', () => {
    expect(homeFor('customer')).toBe('/home');
    expect(homeFor('rider')).toBe('/rider');
  });
});
