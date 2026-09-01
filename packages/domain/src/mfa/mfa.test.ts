import { describe, expect, it } from 'vitest';
import { ROLES, STEP_UP_PERMISSIONS, buildActor } from '../permissions/index.js';
import {
  STEP_UP_WITHOUT_MFA,
  MFA_CHALLENGE_TTL_SECONDS,
  MFA_ENROLMENT_TTL_SECONDS,
  MFA_EPOCH_TOLERANCE_SECONDS,
  MFA_MAX_ATTEMPTS,
  MFA_REQUIRED_ROLES,
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_COUNT,
  assertMfaPolicyCoversStepUp,
  formatRecoveryCode,
  normaliseRecoveryCode,
  requiresMfa,
  summariseRecoveryCodes,
} from './index.js';

describe('which roles require MFA', () => {
  it('covers every role that can reach a step-up permission', () => {
    // The guard that stops policy drift: if someone grants a money-moving
    // permission to a role that does not require a second factor, this throws.
    expect(() => assertMfaPolicyCoversStepUp()).not.toThrow();
  });

  it('records a written reason for every step-up role exempted from MFA', () => {
    // The exemption list is a map, not a set, so granting a step-up permission
    // to a non-MFA role forces someone to write down why in the same commit.
    for (const [role, reason] of STEP_UP_WITHOUT_MFA) {
      expect(ROLES, `${role} is not a real role`).toContain(role);
      expect(MFA_REQUIRED_ROLES.has(role), `${role} both requires and is exempt`).toBe(false);
      expect(reason.length, `${role} has no recorded reason`).toBeGreaterThan(40);
    }
  });

  it('exempts vendor_owner deliberately, not accidentally', () => {
    // vendor_owner holds vendor:payout:write. That is gated behind phone-OTP
    // step-up rather than TOTP: the blast radius is their own settlements, and
    // requiring an authenticator app to change a bank account would push small
    // vendors off the platform. A product decision, recorded as one.
    const actor = buildActor({ identityId: 'i', sessionId: 's', roles: ['vendor_owner'] });
    expect([...actor.permissions]).toContain('vendor:payout:write');
    expect(STEP_UP_PERMISSIONS.has('vendor:payout:write')).toBe(true);
    expect(STEP_UP_WITHOUT_MFA.has('vendor_owner')).toBe(true);
  });

  it('is not satisfied by step-up coverage alone', () => {
    // city_manager, dispatcher, and marketing_manager hold no step-up
    // permission today, but can pause a city, reassign live orders, and message
    // every customer respectively. A purely derived policy would miss them.
    for (const role of ['city_manager', 'dispatcher', 'marketing_manager'] as const) {
      const actor = buildActor({ identityId: 'i', sessionId: 's', roles: [role] });
      const holdsStepUp = [...actor.permissions].some((p) => STEP_UP_PERMISSIONS.has(p));

      expect(holdsStepUp).toBe(false);
      expect(MFA_REQUIRED_ROLES.has(role)).toBe(true);
    }
  });

  it('requires MFA for every staff role', () => {
    const staff = [
      'support_agent',
      'dispatcher',
      'finance_analyst',
      'marketing_manager',
      'city_manager',
      'platform_admin',
      'super_admin',
    ] as const;

    for (const role of staff) {
      expect(requiresMfa([role]), `${role} should require MFA`).toBe(true);
    }
  });

  it('does not force it on customers, riders, or vendor users', () => {
    // A deliberate product decision, not an oversight: their blast radius is
    // their own account, and a rider on a shared phone would be pushed off the
    // platform. Changing this needs a documented decision.
    for (const role of ['customer', 'rider', 'vendor_owner', 'vendor_manager', 'vendor_staff'] as const) {
      expect(requiresMfa([role]), `${role} should not require MFA`).toBe(false);
    }
  });

  it('requires MFA when any one of several roles demands it', () => {
    expect(requiresMfa(['customer', 'finance_analyst'])).toBe(true);
    expect(requiresMfa(['customer', 'rider'])).toBe(false);
  });

  it('treats an empty role list as not requiring MFA', () => {
    expect(requiresMfa([])).toBe(false);
  });

  it('names only real roles', () => {
    for (const role of MFA_REQUIRED_ROLES) {
      expect(ROLES).toContain(role);
    }
  });
});

describe('recovery code formatting', () => {
  it('groups a raw code into fours', () => {
    expect(formatRecoveryCode('ABCD2345EFGH6789')).toBe('ABCD-2345-EFGH-6789');
  });

  it('normalises what a human actually types', () => {
    expect(normaliseRecoveryCode('  abcd-2345 efgh-6789 ')).toBe('ABCD2345EFGH6789');
    expect(normaliseRecoveryCode('ABCD2345EFGH6789')).toBe('ABCD2345EFGH6789');
  });

  it('normalises the displayed form and the raw form identically', () => {
    const raw = 'ABCD2345EFGH6789';
    expect(normaliseRecoveryCode(formatRecoveryCode(raw))).toBe(normaliseRecoveryCode(raw));
  });

  it('excludes every confusable character from the alphabet', () => {
    // The reason no substitution table is needed on the way back in.
    for (const character of ['I', 'L', 'O', 'U', '0', '1']) {
      expect(RECOVERY_CODE_ALPHABET).not.toContain(character);
    }
  });

  it('does not collapse two different codes onto one another', () => {
    expect(normaliseRecoveryCode('ABCD')).not.toBe(normaliseRecoveryCode('ABCE'));
  });
});

describe('recovery code status', () => {
  const unused = { usedAt: null };
  const used = { usedAt: new Date() };

  it('counts what is left', () => {
    const status = summariseRecoveryCodes([unused, unused, used]);
    expect(status.total).toBe(3);
    expect(status.remaining).toBe(2);
    expect(status.exhausted).toBe(false);
  });

  it('flags an exhausted set', () => {
    const status = summariseRecoveryCodes([used, used]);
    expect(status.exhausted).toBe(true);
    // Already out; warning is for the approach, not the arrival.
    expect(status.lowWarning).toBe(false);
  });

  it('warns before the set runs out', () => {
    expect(summariseRecoveryCodes([unused, unused, unused]).lowWarning).toBe(true);
    expect(summariseRecoveryCodes([unused, unused, unused, unused]).lowWarning).toBe(false);
  });

  it('handles an empty set', () => {
    const status = summariseRecoveryCodes([]);
    expect(status.total).toBe(0);
    expect(status.exhausted).toBe(true);
  });
});

describe('policy constants', () => {
  it('keeps the challenge window short', () => {
    // Long enough to open an app and type six digits; short enough that a
    // stolen intermediate token is rarely still usable.
    expect(MFA_CHALLENGE_TTL_SECONDS).toBeLessThanOrEqual(600);
    expect(MFA_CHALLENGE_TTL_SECONDS).toBeGreaterThanOrEqual(120);
  });

  it('bounds attempts against a six-digit code', () => {
    expect(MFA_MAX_ATTEMPTS).toBeGreaterThan(0);
    expect(MFA_MAX_ATTEMPTS).toBeLessThanOrEqual(10);
  });

  it('tolerates no more than one step of clock drift', () => {
    // Every extra period doubles the window in which a shoulder-surfed code
    // still works.
    expect(MFA_EPOCH_TOLERANCE_SECONDS).toBeLessThanOrEqual(30);
  });

  it('issues enough recovery codes to survive a lost phone', () => {
    expect(RECOVERY_CODE_COUNT).toBeGreaterThanOrEqual(8);
  });

  it('does not let an unconfirmed enrolment linger', () => {
    expect(MFA_ENROLMENT_TTL_SECONDS).toBeLessThanOrEqual(3600);
  });
});
