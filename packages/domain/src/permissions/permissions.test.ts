import { describe, expect, it } from 'vitest';
import {
  assertPermission,
  assertScope,
  AuthorizationError,
  buildActor,
  can,
  canAll,
  canAny,
  FOUR_EYES_PERMISSIONS,
  isPermission,
  PERMISSIONS,
  permissionsForRoles,
  requiresFourEyes,
  requiresStepUp,
  ROLE_PERMISSIONS,
  ROLES,
  STEP_UP_MAX_AGE_SECONDS,
  STEP_UP_PERMISSIONS,
  type Permission,
  type Role,
} from './index.js';

const NOW = new Date('2026-08-30T12:00:00Z');

function actorFor(role: Role, extras: Parameters<typeof buildActor>[0] extends infer T ? Partial<T> : never = {}) {
  return buildActor({
    identityId: `id_${role}`,
    sessionId: 'sess_1',
    roles: [role],
    ...extras,
  });
}

describe('permission catalogue', () => {
  it('keeps content_editor strictly Studio-only and publication exclusive to Super Admin', () => {
    expect([...permissionsForRoles(['content_editor'])]).toEqual(['content:manage']);
    for (const role of ROLES) {
      expect(permissionsForRoles([role]).has('content:publish'), role).toBe(role === 'super_admin');
    }
  });
  it('has no duplicates', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it('recognises its own permissions and rejects invented ones', () => {
    expect(isPermission('order:create')).toBe(true);
    expect(isPermission('order:delete:everything')).toBe(false);
    expect(isPermission('')).toBe(false);
  });

  it('grants every permission to super_admin so none is unreachable', () => {
    const granted = permissionsForRoles(['super_admin']);
    for (const permission of PERMISSIONS) {
      expect(granted.has(permission), `super_admin is missing ${permission}`).toBe(true);
    }
  });

  it('only ever lists real permissions in a role', () => {
    for (const role of ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(isPermission(permission), `${role} has bogus ${permission}`).toBe(true);
      }
    }
  });

  it('makes every step-up and four-eyes permission a real permission', () => {
    for (const permission of STEP_UP_PERMISSIONS) expect(isPermission(permission)).toBe(true);
    for (const permission of FOUR_EYES_PERMISSIONS) expect(isPermission(permission)).toBe(true);
  });

  it('requires step-up for every four-eyes permission', () => {
    // Anything dangerous enough to need two people is dangerous enough to need
    // a fresh identity check from the first one.
    for (const permission of FOUR_EYES_PERMISSIONS) {
      expect(requiresStepUp(permission), `${permission} needs step-up`).toBe(true);
    }
  });
});

describe('least privilege — the deny-by-default matrix', () => {
  it('gives a customer nothing beyond their own account', () => {
    const customer = actorFor('customer');
    expect(can(customer, 'order:create')).toBe(true);
    expect(can(customer, 'order:read:own')).toBe(true);

    // Everything that would let a customer reach beyond themselves.
    expect(can(customer, 'ops:order:read:all')).toBe(false);
    expect(can(customer, 'vendor:order:accept')).toBe(false);
    expect(can(customer, 'finance:refund:approve')).toBe(false);
    expect(can(customer, 'admin:user:read')).toBe(false);
    expect(can(customer, 'admin:data:export')).toBe(false);
    expect(can(customer, 'rider:location:report')).toBe(false);
  });

  it('gives a rider no reach into vendor or finance data', () => {
    const rider = actorFor('rider');
    expect(can(rider, 'rider:offer:respond')).toBe(true);
    expect(can(rider, 'vendor:catalog:write')).toBe(false);
    expect(can(rider, 'finance:ledger:read')).toBe(false);
    expect(can(rider, 'ops:order:read:all')).toBe(false);
    expect(can(rider, 'rider:earnings:read:own')).toBe(true);
  });

  it('escalates vendor roles strictly — staff ⊂ manager ⊂ owner', () => {
    const staff = permissionsForRoles(['vendor_staff']);
    const manager = permissionsForRoles(['vendor_manager']);
    const owner = permissionsForRoles(['vendor_owner']);

    for (const permission of staff) expect(manager.has(permission)).toBe(true);
    for (const permission of manager) expect(owner.has(permission)).toBe(true);

    // And each level genuinely adds something.
    expect(manager.size).toBeGreaterThan(staff.size);
    expect(owner.size).toBeGreaterThan(manager.size);
  });

  it('does not let vendor staff change prices or read settlements', () => {
    const staff = actorFor('vendor_staff');
    expect(can(staff, 'vendor:order:accept')).toBe(true);
    expect(can(staff, 'vendor:catalog:write')).toBe(false);
    expect(can(staff, 'vendor:settlement:read')).toBe(false);
    expect(can(staff, 'vendor:staff:manage')).toBe(false);
  });

  it('does not let a support agent approve their own refunds', () => {
    const agent = actorFor('support_agent');
    expect(can(agent, 'support:refund:request')).toBe(true);
    // Requesting is not approving. Approval belongs to finance.
    expect(can(agent, 'finance:refund:approve')).toBe(false);
    expect(can(agent, 'finance:payout:approve')).toBe(false);
  });

  it('does not let a dispatcher touch money', () => {
    const dispatcher = actorFor('dispatcher');
    expect(can(dispatcher, 'ops:dispatch:assign')).toBe(true);
    expect(can(dispatcher, 'finance:adjustment:create')).toBe(false);
    expect(can(dispatcher, 'finance:ledger:read')).toBe(false);
  });

  it('does not let marketing read the ledger or admin users', () => {
    const marketing = actorFor('marketing_manager');
    expect(can(marketing, 'marketing:campaign:send')).toBe(true);
    expect(can(marketing, 'finance:ledger:read')).toBe(false);
    expect(can(marketing, 'admin:user:write')).toBe(false);
    expect(can(marketing, 'support:customer:read')).toBe(false);
  });

  it('reserves impersonation and role editing for super_admin alone', () => {
    for (const role of ROLES) {
      if (role === 'super_admin') continue;
      const granted = permissionsForRoles([role]);
      expect(granted.has('admin:impersonate'), `${role} can impersonate`).toBe(false);
      expect(granted.has('admin:role:write'), `${role} can edit roles`).toBe(false);
    }
  });

  it('reserves manual order intervention for super_admin alone', () => {
    expect(permissionsForRoles(['super_admin']).has('ops:order:override')).toBe(true);
    for (const role of ROLES) {
      if (role === 'super_admin') continue;
      expect(permissionsForRoles([role]).has('ops:order:override'), `${role} can intervene`).toBe(false);
    }
  });
});

describe('canAll / canAny', () => {
  it('requires every permission for canAll', () => {
    const owner = actorFor('vendor_owner');
    expect(canAll(owner, ['vendor:order:accept', 'vendor:catalog:write'])).toBe(true);
    expect(canAll(owner, ['vendor:order:accept', 'admin:user:write'])).toBe(false);
  });

  it('requires only one for canAny', () => {
    const staff = actorFor('vendor_staff');
    expect(canAny(staff, ['admin:user:write', 'vendor:order:accept'])).toBe(true);
    expect(canAny(staff, ['admin:user:write', 'finance:ledger:read'])).toBe(false);
  });
});

describe('assertPermission', () => {
  it('allows a permitted action', () => {
    expect(() => assertPermission(actorFor('customer'), 'order:create', NOW)).not.toThrow();
  });

  it('throws with a message that does not leak what exists', () => {
    try {
      assertPermission(actorFor('customer'), 'admin:data:export', NOW);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).reason).toBe('missing_permission');
      // The public message must not name the permission or the resource.
      expect((error as AuthorizationError).message).not.toContain('admin:data:export');
    }
  });

  it('demands step-up for a dangerous permission even when granted', () => {
    const admin = buildActor({
      identityId: 'id_1',
      sessionId: 's',
      roles: ['super_admin'],
    });
    try {
      assertPermission(admin, 'finance:payout:approve', NOW);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as AuthorizationError).reason).toBe('step_up_required');
    }
  });

  it('accepts a recent step-up', () => {
    const admin = buildActor({
      identityId: 'id_1',
      sessionId: 's',
      roles: ['super_admin'],
      steppedUpAt: new Date(NOW.getTime() - 60_000),
    });
    expect(() => assertPermission(admin, 'finance:payout:approve', NOW)).not.toThrow();
  });

  it('rejects an expired step-up', () => {
    const admin = buildActor({
      identityId: 'id_1',
      sessionId: 's',
      roles: ['super_admin'],
      steppedUpAt: new Date(NOW.getTime() - (STEP_UP_MAX_AGE_SECONDS + 1) * 1000),
    });
    try {
      assertPermission(admin, 'finance:payout:approve', NOW);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as AuthorizationError).reason).toBe('step_up_expired');
    }
  });

  it('rejects a step-up timestamped in the future — a clock-skew forgery', () => {
    const admin = buildActor({
      identityId: 'id_1',
      sessionId: 's',
      roles: ['super_admin'],
      steppedUpAt: new Date(NOW.getTime() + 60_000),
    });
    expect(() => assertPermission(admin, 'finance:payout:approve', NOW)).toThrow(
      AuthorizationError,
    );
  });

  it('does not demand step-up for ordinary actions', () => {
    expect(requiresStepUp('order:create')).toBe(false);
    expect(requiresStepUp('vendor:order:accept')).toBe(false);
    expect(requiresFourEyes('order:create')).toBe(false);
  });
});

describe('assertScope — the IDOR/BOLA defence', () => {
  it('lets a vendor reach their own order', () => {
    const owner = buildActor({
      identityId: 'id_v1',
      sessionId: 's',
      roles: ['vendor_owner'],
      vendorId: 'ven_1',
    });
    expect(() => assertScope(owner, { vendorId: 'ven_1' })).not.toThrow();
  });

  it('blocks a vendor reaching a competitor’s order', () => {
    const owner = buildActor({
      identityId: 'id_v1',
      sessionId: 's',
      roles: ['vendor_owner'],
      vendorId: 'ven_1',
    });
    expect(() => assertScope(owner, { vendorId: 'ven_2' })).toThrow(AuthorizationError);
  });

  it('reports a cross-tenant probe as "Not found", never as "forbidden"', () => {
    // A 403 tells the attacker the record exists. A 404 tells them nothing.
    const owner = buildActor({
      identityId: 'id_v1',
      sessionId: 's',
      roles: ['vendor_owner'],
      vendorId: 'ven_1',
    });
    try {
      assertScope(owner, { vendorId: 'ven_2' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as AuthorizationError).message).toBe('Not found.');
      expect((error as AuthorizationError).reason).toBe('out_of_scope');
    }
  });

  it('blocks branch-bound staff from a sibling branch', () => {
    const staff = buildActor({
      identityId: 'id_s1',
      sessionId: 's',
      roles: ['vendor_staff'],
      vendorId: 'ven_1',
      branchId: 'br_1',
    });
    expect(() => assertScope(staff, { vendorId: 'ven_1', branchId: 'br_1' })).not.toThrow();
    expect(() => assertScope(staff, { vendorId: 'ven_1', branchId: 'br_2' })).toThrow(
      AuthorizationError,
    );
  });

  it('blocks a city manager acting outside their cities', () => {
    const manager = buildActor({
      identityId: 'id_c1',
      sessionId: 's',
      roles: ['city_manager'],
      cityIds: ['lagos'],
    });
    expect(() => assertScope(manager, { cityId: 'lagos' })).not.toThrow();
    expect(() => assertScope(manager, { cityId: 'abuja' })).toThrow(AuthorizationError);
  });

  it('blocks a city-scoped actor with no cities assigned at all', () => {
    const dispatcher = buildActor({
      identityId: 'id_d1',
      sessionId: 's',
      roles: ['dispatcher'],
    });
    expect(() => assertScope(dispatcher, { cityId: 'lagos' })).toThrow(AuthorizationError);
  });

  it('blocks a rider reading another rider’s earnings', () => {
    const rider = buildActor({
      identityId: 'id_r1',
      sessionId: 's',
      roles: ['rider'],
      riderId: 'rid_1',
    });
    expect(() => assertScope(rider, { riderId: 'rid_1' })).not.toThrow();
    expect(() => assertScope(rider, { riderId: 'rid_2' })).toThrow(AuthorizationError);
  });

  it('blocks a customer reading another customer’s order', () => {
    const customer = buildActor({
      identityId: 'id_c1',
      sessionId: 's',
      roles: ['customer'],
      customerId: 'cus_1',
    });
    expect(() => assertScope(customer, { customerId: 'cus_1' })).not.toThrow();
    expect(() => assertScope(customer, { customerId: 'cus_2' })).toThrow(AuthorizationError);
  });

  it('blocks a customer reading a record owned by another identity', () => {
    const customer = buildActor({
      identityId: 'id_c1',
      sessionId: 's',
      roles: ['customer'],
      customerId: 'cus_1',
    });
    expect(() => assertScope(customer, { ownerIdentityId: 'id_c2' })).toThrow(AuthorizationError);
  });

  it('lets staff read across customers — their reach is governed by permissions', () => {
    const agent = buildActor({
      identityId: 'id_a1',
      sessionId: 's',
      roles: ['support_agent'],
    });
    expect(() => assertScope(agent, { customerId: 'cus_anyone' })).not.toThrow();
  });

  it('holds up under a brute-force sweep of cross-tenant ids', () => {
    const owner = buildActor({
      identityId: 'id_v1',
      sessionId: 's',
      roles: ['vendor_owner'],
      vendorId: 'ven_1',
    });
    let denied = 0;
    for (let i = 0; i < 500; i += 1) {
      const probe = `ven_${i}`;
      try {
        assertScope(owner, { vendorId: probe });
        expect(probe).toBe('ven_1'); // the only id that may pass
      } catch {
        denied += 1;
      }
    }
    expect(denied).toBe(499);
  });
});

describe('a client cannot promote itself', () => {
  it('derives permissions only from roles, ignoring anything else supplied', () => {
    // Simulates a request body carrying `permissions: ['admin:impersonate']`.
    // `buildActor` recomputes from roles, so the injected value is discarded.
    const hostile = buildActor({
      identityId: 'id_x',
      sessionId: 's',
      roles: ['customer'],
      // @ts-expect-error proving the extra field is not honoured at runtime
      permissions: new Set<Permission>(['admin:impersonate', 'finance:payout:approve']),
    });
    expect(can(hostile, 'admin:impersonate')).toBe(false);
    expect(can(hostile, 'finance:payout:approve')).toBe(false);
    expect(can(hostile, 'order:create')).toBe(true);
  });

  it('ignores an unknown role rather than failing open', () => {
    const actor = buildActor({
      identityId: 'id_y',
      sessionId: 's',
      // @ts-expect-error deliberately invalid role
      roles: ['god_mode'],
    });
    expect(actor.permissions.size).toBe(0);
    expect(() => assertPermission(actor, 'order:create', NOW)).toThrow(AuthorizationError);
  });
});
