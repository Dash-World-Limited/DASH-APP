import { describe, expect, it } from 'vitest';
import {
  AccountPolicyError,
  anonymisedAddress,
  anonymisedIdentity,
  assertCoolingOffDays,
  assertDeletionTransition,
  assertExportTransition,
  assertExportTtlHours,
  canOwnerCancelDeletion,
  canTransitionDeletion,
  canTransitionExport,
  DATA_CLASS_RULES,
  dataClassRule,
  DELETION_COOLING_OFF_DAYS,
  DELETION_COOLING_OFF_MAX_DAYS,
  DELETION_PENDING_STATUSES,
  EXPORT_BUILD_CLAIM_SECONDS,
  EXPORT_BUILD_MAX_ATTEMPTS,
  EXPORT_DOWNLOAD_LEASE_SECONDS,
  evaluateLegalHold,
  EXPORT_DOWNLOAD_TTL_HOURS,
  EXPORT_SECTIONS,
  exportExpiresAt,
  exportManifest,
  isCancellable,
  isDownloadable,
  isDueForFinalisation,
  purgeAfter,
  type LegalHoldSignals,
} from './index.js';

const NO_HOLD: LegalHoldSignals = {
  hasOpenOrder: false,
  hasUnresolvedPaymentDispute: false,
  hasOpenDisputeOrSafetyCase: false,
  owesMoney: false,
};

describe('timings', () => {
  it('places the purge instant a whole cooling-off window after the request', () => {
    const requestedAt = new Date('2026-06-01T00:00:00Z');
    const purge = purgeAfter(requestedAt);
    const days = (purge.getTime() - requestedAt.getTime()) / 86_400_000;
    expect(days).toBe(DELETION_COOLING_OFF_DAYS);
  });

  it('accepts a shortened window but refuses one past the ceiling', () => {
    expect(() => assertCoolingOffDays(1)).not.toThrow();
    expect(() => assertCoolingOffDays(DELETION_COOLING_OFF_MAX_DAYS)).not.toThrow();
    expect(() => assertCoolingOffDays(DELETION_COOLING_OFF_MAX_DAYS + 1)).toThrow(AccountPolicyError);
    expect(() => assertCoolingOffDays(0)).toThrow(AccountPolicyError);
    expect(() => assertCoolingOffDays(7.5)).toThrow(AccountPolicyError);
  });

  it('rejects an out-of-range window inside purgeAfter itself', () => {
    expect(() => purgeAfter(new Date(), 3650)).toThrow(/cooling-off/);
  });

  it('expires an export a whole TTL after it becomes ready', () => {
    const readyAt = new Date('2026-06-01T00:00:00Z');
    const hours = (exportExpiresAt(readyAt).getTime() - readyAt.getTime()) / 3_600_000;
    expect(hours).toBe(EXPORT_DOWNLOAD_TTL_HOURS);
  });

  it('bounds the export TTL', () => {
    expect(() => assertExportTtlHours(1)).not.toThrow();
    expect(() => assertExportTtlHours(168)).not.toThrow();
    expect(() => assertExportTtlHours(169)).toThrow(AccountPolicyError);
    expect(() => assertExportTtlHours(0)).toThrow(AccountPolicyError);
  });
});

describe('deletion state machine', () => {
  it('allows scheduled → held / cancelled / completed', () => {
    expect(canTransitionDeletion('scheduled', 'held')).toBe(true);
    expect(canTransitionDeletion('scheduled', 'cancelled')).toBe(true);
    expect(canTransitionDeletion('scheduled', 'completed')).toBe(true);
  });

  it('lets a held request resume, finalise, or be cancelled — but never expire', () => {
    expect(canTransitionDeletion('held', 'scheduled')).toBe(true);
    expect(canTransitionDeletion('held', 'completed')).toBe(true);
    expect(canTransitionDeletion('held', 'cancelled')).toBe(true);
    expect(canTransitionDeletion('held', 'held')).toBe(false);
  });

  it('makes cancelled and completed terminal', () => {
    for (const to of ['scheduled', 'held', 'cancelled', 'completed'] as const) {
      expect(canTransitionDeletion('cancelled', to)).toBe(false);
      expect(canTransitionDeletion('completed', to)).toBe(false);
    }
  });

  it('never reopens or re-schedules a finished deletion', () => {
    expect(canTransitionDeletion('scheduled', 'scheduled')).toBe(false);
    expect(() => assertDeletionTransition('completed', 'scheduled')).toThrow(AccountPolicyError);
  });

  it('names both non-terminal statuses a maintenance run acts on', () => {
    expect([...DELETION_PENDING_STATUSES].sort()).toEqual(['held', 'scheduled']);
  });

  it('is due for finalisation once a held request has passed its window', () => {
    const held = { status: 'held' as const, scheduledPurgeAt: new Date('2026-06-15T00:00:00Z') };
    expect(isDueForFinalisation(held, new Date('2026-06-14T23:59:59Z'))).toBe(false);
    expect(isDueForFinalisation(held, new Date('2026-06-15T00:00:01Z'))).toBe(true);
  });

  it('lets the owner cancel a held request at any time, and a scheduled one only in-window', () => {
    const at = new Date('2026-06-20T00:00:00Z');
    const purgeAt = new Date('2026-06-15T00:00:00Z');
    expect(canOwnerCancelDeletion({ status: 'held', scheduledPurgeAt: purgeAt }, at)).toBe(true);
    expect(canOwnerCancelDeletion({ status: 'scheduled', scheduledPurgeAt: purgeAt }, at)).toBe(false);
    expect(
      canOwnerCancelDeletion(
        { status: 'scheduled', scheduledPurgeAt: purgeAt },
        new Date('2026-06-10T00:00:00Z'),
      ),
    ).toBe(true);
    expect(canOwnerCancelDeletion({ status: 'completed', scheduledPurgeAt: purgeAt }, at)).toBe(false);
  });

  it('is due only once the window has passed', () => {
    const window = { status: 'scheduled' as const, scheduledPurgeAt: new Date('2026-06-15T00:00:00Z') };
    expect(isDueForFinalisation(window, new Date('2026-06-14T23:59:59Z'))).toBe(false);
    expect(isDueForFinalisation(window, new Date('2026-06-15T00:00:00Z'))).toBe(true);
  });

  it('is not due once cancelled or already completed', () => {
    const past = new Date('2020-01-01T00:00:00Z');
    expect(isDueForFinalisation({ status: 'cancelled', scheduledPurgeAt: past }, new Date())).toBe(
      false,
    );
    expect(isDueForFinalisation({ status: 'completed', scheduledPurgeAt: past }, new Date())).toBe(
      false,
    );
  });

  it('is cancellable only while scheduled and before the window closes', () => {
    const req = { status: 'scheduled' as const, scheduledPurgeAt: new Date('2026-06-15T00:00:00Z') };
    expect(isCancellable(req, new Date('2026-06-10T00:00:00Z'))).toBe(true);
    expect(isCancellable(req, new Date('2026-06-15T00:00:01Z'))).toBe(false);
    expect(
      isCancellable({ status: 'completed', scheduledPurgeAt: req.scheduledPurgeAt }, new Date('2026-06-10T00:00:00Z')),
    ).toBe(false);
  });
});

describe('legal holds', () => {
  it('lets a clean account through', () => {
    expect(evaluateLegalHold(NO_HOLD)).toBeNull();
  });

  it('blocks on an open order first', () => {
    expect(evaluateLegalHold({ ...NO_HOLD, hasOpenOrder: true })?.code).toBe('open_order');
  });

  it('blocks on a payment dispute', () => {
    expect(
      evaluateLegalHold({ ...NO_HOLD, hasUnresolvedPaymentDispute: true })?.code,
    ).toBe('payment_dispute');
  });

  it('blocks on an open dispute or safety case', () => {
    expect(
      evaluateLegalHold({ ...NO_HOLD, hasOpenDisputeOrSafetyCase: true })?.code,
    ).toBe('dispute_or_safety_case');
  });

  it('blocks on an outstanding balance', () => {
    expect(evaluateLegalHold({ ...NO_HOLD, owesMoney: true })?.code).toBe('outstanding_balance');
  });

  it('reports the most actionable hold when several apply', () => {
    const hold = evaluateLegalHold({
      hasOpenOrder: true,
      hasUnresolvedPaymentDispute: true,
      hasOpenDisputeOrSafetyCase: true,
      owesMoney: true,
    });
    expect(hold?.code).toBe('open_order');
  });

  it('gives every hold a message that tells the person what to do', () => {
    for (const signal of [
      'hasOpenOrder',
      'hasUnresolvedPaymentDispute',
      'hasOpenDisputeOrSafetyCase',
      'owesMoney',
    ] as const) {
      const hold = evaluateLegalHold({ ...NO_HOLD, [signal]: true });
      expect(hold?.message).toMatch(/can proceed once/i);
    }
  });
});

describe('anonymisation values', () => {
  it('is deterministic in the account id', () => {
    expect(anonymisedIdentity('acc_1')).toEqual(anonymisedIdentity('acc_1'));
  });

  it('does not collide two accounts on one placeholder', () => {
    expect(anonymisedIdentity('acc_1').email).not.toBe(anonymisedIdentity('acc_2').email);
  });

  it('routes the placeholder email nowhere real', () => {
    // RFC 2606: .invalid can never be a real TLD.
    expect(anonymisedIdentity('acc_1').email).toMatch(/\.invalid$/);
  });

  it('clears every authentication field', () => {
    const a = anonymisedIdentity('acc_1');
    expect(a.phone).toBeNull();
    expect(a.passwordHash).toBeNull();
    expect(a.mfaSecretCipher).toBeNull();
    expect(a.mfaPendingCipher).toBeNull();
    expect(a.mfaEnrolledAt).toBeNull();
    expect(a.mfaLastTimeStep).toBeNull();
    expect(a.status).toBe('deleted');
  });

  it('strips an address to a placeholder that still parses', () => {
    const addr = anonymisedAddress();
    expect(addr.line1).not.toMatch(/\d/);
    expect(addr.contactPhone).not.toMatch(/\d/);
    expect(addr.latitude).toBe(0);
    expect(addr.longitude).toBe(0);
    expect(addr.landmark).toBeNull();
    expect(addr.instructions).toBeNull();
  });
});

describe('the data-class policy', () => {
  it('names each model once', () => {
    const models = DATA_CLASS_RULES.map((rule) => rule.model);
    expect(new Set(models).size).toBe(models.length);
  });

  it('gives every rule a reason a reviewer can read', () => {
    for (const rule of DATA_CLASS_RULES) {
      expect(rule.reason.length, `${rule.model} has a thin reason`).toBeGreaterThan(40);
    }
  });

  it('retains every ledger and accounting model, deletes none of them', () => {
    for (const model of [
      'LedgerTransaction',
      'LedgerEntry',
      'Payment',
      'Refund',
      'Subscription',
      'LegalAcceptance',
      'AuditLog',
      'OrderItem',
      'PaymentMethodSetup',
    ]) {
      expect(dataClassRule(model).action, `${model} must be retained`).toBe('retain');
    }
  });

  it('anonymises rather than deletes anything an order or the ledger references', () => {
    for (const model of ['Identity', 'Customer', 'Address', 'Order', 'Review']) {
      expect(dataClassRule(model).action, `${model} must be anonymised, not deleted`).toBe(
        'anonymise',
      );
    }
  });

  it('only ever deletes credentials and drafts', () => {
    const deletes = DATA_CLASS_RULES.filter((r) => r.action === 'delete').map((r) => r.model);
    expect(deletes.sort()).toEqual(
      // PaymentMethod is a payment credential: a saved card's provider token.
      ['Cart', 'Device', 'MfaChallenge', 'MfaRecoveryCode', 'OtpChallenge', 'PaymentMethod', 'Session'].sort(),
    );
  });

  it('throws for a model it does not know', () => {
    expect(() => dataClassRule('Nonsense')).toThrow(/No data-class rule/);
  });
});

describe('export manifest', () => {
  it('states the boundary of what is included', () => {
    const manifest = exportManifest('acc_1', new Date('2026-06-01T00:00:00Z'));
    expect(manifest.format).toBe('json');
    expect(manifest.subjectId).toBe('acc_1');
    expect(manifest.sections).toEqual(EXPORT_SECTIONS);
    expect(manifest.notice).toMatch(/does not include other users/i);
  });

  it('never lists a section that is somebody else\'s data', () => {
    for (const section of EXPORT_SECTIONS) {
      expect(section).not.toMatch(/staff|risk|fraud|internal|admin/i);
    }
  });
});

describe('export state machine', () => {
  it('builds through a claim: pending → building → ready → delivered', () => {
    expect(canTransitionExport('pending', 'building')).toBe(true);
    expect(canTransitionExport('building', 'ready')).toBe(true);
    expect(canTransitionExport('ready', 'delivered')).toBe(true);
  });

  it('will not skip the build claim', () => {
    expect(canTransitionExport('pending', 'ready')).toBe(false);
    expect(() => assertExportTransition('pending', 'ready')).toThrow(AccountPolicyError);
  });

  it('lets a building request fail, or fall back to pending when its claim goes stale', () => {
    expect(canTransitionExport('building', 'failed')).toBe(true);
    expect(canTransitionExport('building', 'pending')).toBe(true);
  });

  it('allows pending → failed and ready → expired', () => {
    expect(canTransitionExport('pending', 'failed')).toBe(true);
    expect(canTransitionExport('ready', 'expired')).toBe(true);
  });

  it('makes delivered, expired, and failed terminal', () => {
    for (const from of ['delivered', 'expired', 'failed'] as const) {
      for (const to of ['pending', 'building', 'ready', 'delivered', 'expired', 'failed'] as const) {
        expect(canTransitionExport(from, to)).toBe(false);
      }
    }
  });

  it('will not skip straight from pending to delivered', () => {
    expect(() => assertExportTransition('pending', 'delivered')).toThrow(AccountPolicyError);
  });

  it('exposes sane operational bounds for the build claim and download lease', () => {
    expect(EXPORT_BUILD_CLAIM_SECONDS).toBeGreaterThan(EXPORT_DOWNLOAD_LEASE_SECONDS);
    expect(EXPORT_DOWNLOAD_LEASE_SECONDS).toBeGreaterThanOrEqual(30);
    expect(EXPORT_BUILD_MAX_ATTEMPTS).toBeGreaterThanOrEqual(3);
  });

  it('is downloadable only while ready, unused, and inside its TTL', () => {
    const base = { status: 'ready' as const, downloadCount: 0, expiresAt: new Date('2026-06-02T00:00:00Z') };
    const now = new Date('2026-06-01T12:00:00Z');

    expect(isDownloadable(base, now)).toBe(true);
    expect(isDownloadable({ ...base, downloadCount: 1 }, now)).toBe(false);
    expect(isDownloadable({ ...base, status: 'pending' }, now)).toBe(false);
    expect(isDownloadable({ ...base, expiresAt: new Date('2026-05-31T00:00:00Z') }, now)).toBe(false);
    expect(isDownloadable({ ...base, expiresAt: null }, now)).toBe(false);
  });
});
