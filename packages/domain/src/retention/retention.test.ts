import { describe, expect, it } from 'vitest';
import {
  ANONYMISED_LOCATION_DECIMALS,
  assertRetentionDays,
  coarsenCoordinate,
  cutoffFor,
  MAX_ALLOWED_DAYS,
  RETENTION_RULES,
  RetentionPolicyError,
  ruleFor,
  summariseRetention,
  type RetentionOutcome,
} from './index.js';

describe('the policy itself', () => {
  it('names every rule uniquely', () => {
    const names = RETENTION_RULES.map((rule) => rule.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every rule a reason a reviewer can read', () => {
    for (const rule of RETENTION_RULES) {
      expect(rule.reason.length, `${rule.name} has no real reason`).toBeGreaterThan(40);
    }
  });

  it('pairs a period with every delete or anonymise, and none with retain', () => {
    for (const rule of RETENTION_RULES) {
      if (rule.action === 'retain') {
        expect(rule.afterDays, `${rule.name} retains but names a period`).toBeNull();
      } else {
        expect(rule.afterDays, `${rule.name} has no period`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps every financial and audit record', () => {
    // The line that must not move. Deleting any of these is unrecoverable and,
    // in Nigeria, probably unlawful.
    const mustRetain = [
      'ledger_transactions',
      'ledger_entries',
      'payments_and_refunds',
      'orders',
      'settlements_and_payouts',
      'audit_log',
      'payment_webhooks',
    ];
    for (const name of mustRetain) {
      expect(ruleFor(name).action, `${name} is no longer retained`).toBe('retain');
    }
  });

  it('only ever deletes data with no evidential or accounting value', () => {
    const deletes = RETENTION_RULES.filter((rule) => rule.action === 'delete').map((r) => r.name);
    // Spot-check the intent: everything deletable is a spent credential, a
    // rejected data point, or a cache entry.
    expect(deletes).toEqual(
      expect.arrayContaining([
        'expired_sessions',
        'consumed_otp_challenges',
        'consumed_mfa_challenges',
        'expired_idempotency_keys',
        'rejected_rider_locations',
      ]),
    );
    expect(deletes).not.toContain('orders');
    expect(deletes).not.toContain('audit_log');
  });

  it('anonymises rather than deletes a rider movement trail', () => {
    expect(ruleFor('rider_location_history').action).toBe('anonymise');
  });
});

describe('ruleFor', () => {
  it('throws for a name the policy does not define', () => {
    expect(() => ruleFor('not_a_rule')).toThrow(/No retention rule/);
  });
});

describe('cutoffFor', () => {
  const now = new Date('2026-06-01T12:00:00Z');

  it('is null for a retained class — nothing expires', () => {
    expect(cutoffFor(ruleFor('audit_log'), now)).toBeNull();
  });

  it('is afterDays before now for a delete rule', () => {
    const cutoff = cutoffFor(ruleFor('expired_sessions'), now)!;
    const days = (now.getTime() - cutoff.getTime()) / 86_400_000;
    expect(days).toBe(60);
  });

  it('takes the instant it is given rather than reading the clock', () => {
    const a = cutoffFor(ruleFor('consumed_otp_challenges'), new Date('2020-01-01T00:00:00Z'))!;
    const b = cutoffFor(ruleFor('consumed_otp_challenges'), new Date('2026-01-01T00:00:00Z'))!;
    expect(a.getTime()).not.toBe(b.getTime());
  });
});

describe('assertRetentionDays', () => {
  it('accepts a value at or below the ceiling', () => {
    expect(() => assertRetentionDays('expired_sessions', 30)).not.toThrow();
    expect(() =>
      assertRetentionDays('expired_sessions', MAX_ALLOWED_DAYS['expired_sessions']!),
    ).not.toThrow();
  });

  it('refuses a value above the ceiling, naming both', () => {
    const ceiling = MAX_ALLOWED_DAYS['rider_location_history']!;
    expect(() => assertRetentionDays('rider_location_history', ceiling + 1)).toThrow(
      RetentionPolicyError,
    );
    try {
      assertRetentionDays('rider_location_history', 9999);
    } catch (error) {
      expect((error as Error).message).toContain('rider_location_history');
      expect((error as Error).message).toContain(String(ceiling));
    }
  });

  it('refuses zero, negatives, and fractions', () => {
    for (const days of [0, -1, 1.5, Number.NaN]) {
      expect(() => assertRetentionDays('expired_sessions', days), `days=${days}`).toThrow(
        RetentionPolicyError,
      );
    }
  });

  it('refuses to configure a period for a retained class at all', () => {
    expect(() => assertRetentionDays('audit_log', 30)).toThrow(/retained indefinitely/);
  });

  it('refuses an unknown rule name', () => {
    expect(() => assertRetentionDays('made_up', 10)).toThrow();
  });

  it('has a ceiling for every configurable rule', () => {
    // A configurable rule with no ceiling is a period an operator could widen
    // without limit — which is the thing the ceiling exists to prevent.
    for (const rule of RETENTION_RULES) {
      if (rule.action === 'retain') continue;
      expect(MAX_ALLOWED_DAYS[rule.name], `${rule.name} has no ceiling`).toBeGreaterThan(0);
    }
  });

  it('sets every ceiling at or above the policy default', () => {
    for (const rule of RETENTION_RULES) {
      if (rule.action === 'retain') continue;
      expect(
        MAX_ALLOWED_DAYS[rule.name]!,
        `${rule.name} ceiling is below its own default`,
      ).toBeGreaterThanOrEqual(rule.afterDays!);
    }
  });
});

describe('coarsenCoordinate', () => {
  it('rounds to the policy precision', () => {
    expect(coarsenCoordinate(6.523491)).toBe(6.52);
    expect(coarsenCoordinate(3.379812)).toBe(3.38);
    expect(ANONYMISED_LOCATION_DECIMALS).toBe(2);
  });

  it('is idempotent — coarsening a coarse value changes nothing', () => {
    const once = coarsenCoordinate(6.523491);
    expect(coarsenCoordinate(once)).toBe(once);
  });

  it('drops enough precision to lose the building', () => {
    // Two points ~300m apart must collapse to the same value; that is the point.
    expect(coarsenCoordinate(6.5231)).toBe(coarsenCoordinate(6.5234));
  });

  it('handles negatives and zero', () => {
    expect(coarsenCoordinate(-0.1187)).toBe(-0.12);
    expect(coarsenCoordinate(0)).toBe(0);
  });
});

describe('summariseRetention', () => {
  const outcomes: RetentionOutcome[] = [
    { rule: 'expired_sessions', action: 'delete', cutoff: new Date(), affected: 10, dryRun: false },
    { rule: 'audit_log', action: 'retain', cutoff: null, affected: 0, dryRun: false },
    {
      rule: 'rider_location_history',
      action: 'anonymise',
      cutoff: new Date(),
      affected: 5,
      dryRun: false,
      error: 'boom',
    },
  ];

  it('totals affected rows across rules', () => {
    const report = summariseRetention(new Date(), new Date(), false, outcomes);
    expect(report.totalAffected).toBe(15);
  });

  it('counts rules that errored', () => {
    const report = summariseRetention(new Date(), new Date(), false, outcomes);
    expect(report.failed).toBe(1);
  });

  it('carries the dry-run flag through', () => {
    expect(summariseRetention(new Date(), new Date(), true, []).dryRun).toBe(true);
  });
});
