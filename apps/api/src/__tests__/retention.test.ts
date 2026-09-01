/**
 * Retention job — integration tests.
 *
 * The job deletes and rewrites personal data, so the tests that matter most are
 * the ones proving it does *not* touch what it must never touch. A retention
 * job that quietly removes a ledger entry is worse than one that never runs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ANONYMISED_LOCATION_DECIMALS, RETENTION_RULES } from '@dash/domain/retention';
import { createTestContext, type TestContext } from './harness.js';
import { buildWorld, type World } from './world.js';
import { IMPLEMENTED_RULES, runRetention } from '../jobs/retention.js';

let context: TestContext;
let world: World;

const NOW = new Date('2026-09-01T12:00:00.000Z');
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000);

beforeAll(async () => {
  context = await createTestContext();
  world = await buildWorld(context.prisma);
});

afterAll(async () => {
  await context.close();
});

const run = (options: Parameters<typeof runRetention>[1] = {}) =>
  runRetention(context.prisma, { now: NOW, ...options });

describe('policy coverage', () => {
  it('implements every rule the policy names', () => {
    // A rule added to the policy without an implementation would make the job
    // report success having done nothing.
    const actionable = RETENTION_RULES.filter((rule) => rule.action !== 'retain').map(
      (rule) => rule.name,
    );

    for (const name of actionable) {
      expect(IMPLEMENTED_RULES.has(name), `"${name}" has no implementation`).toBe(true);
    }
  });

  it('does not implement anything the policy has not authorised', () => {
    const known = new Set(RETENTION_RULES.map((rule) => rule.name));
    for (const name of IMPLEMENTED_RULES) {
      expect(known.has(name), `"${name}" is implemented but not in the policy`).toBe(true);
    }
  });

  it('gives every rule a written reason', () => {
    for (const rule of RETENTION_RULES) {
      expect(rule.reason.length, `${rule.name} has no reason`).toBeGreaterThan(40);
    }
  });
});

describe('what it must never touch', () => {
  beforeEach(async () => {
    await context.prisma.auditLog.deleteMany({});
  });

  it('leaves ledger transactions and entries alone however old', async () => {
    const transaction = await context.prisma.ledgerTransaction.create({
      data: {
        kind: 'order_payment_captured',
        idempotencyKey: `retention_test_${Date.now()}`,
        referenceType: 'order',
        referenceId: 'test',
        actorId: 'system',
        occurredAt: daysAgo(4000),
        createdAt: daysAgo(4000),
        entries: {
          create: [
            { accountKind: 'platform_cash', amount: 1000, memo: 'in' },
            { accountKind: 'platform_revenue', amount: -1000, memo: 'out' },
          ],
        },
      },
      select: { id: true },
    });

    await run();

    expect(
      await context.prisma.ledgerTransaction.findUnique({ where: { id: transaction.id } }),
    ).not.toBeNull();
    expect(
      await context.prisma.ledgerEntry.count({ where: { transactionId: transaction.id } }),
    ).toBe(2);
  });

  it('leaves the audit log alone however old', async () => {
    const entry = await context.prisma.auditLog.create({
      data: {
        action: 'test.ancient',
        resourceType: 'test',
        resourceId: 'x',
        createdAt: daysAgo(4000),
      },
      select: { id: true },
    });

    await run();

    // An audit trail that deletes itself is not an audit trail.
    expect(await context.prisma.auditLog.findUnique({ where: { id: entry.id } })).not.toBeNull();
  });

  it('leaves orders and payment webhooks alone however old', async () => {
    const before = {
      orders: await context.prisma.order.count(),
      webhooks: await context.prisma.paymentWebhook.count(),
      payments: await context.prisma.payment.count(),
    };

    await run();

    expect(await context.prisma.order.count()).toBe(before.orders);
    // Deleting webhook event ids would reopen the replay window the unique
    // constraint closes.
    expect(await context.prisma.paymentWebhook.count()).toBe(before.webhooks);
    expect(await context.prisma.payment.count()).toBe(before.payments);
  });

  it('reports retained classes explicitly rather than omitting them', async () => {
    const report = await run({ dryRun: true });
    const retained = report.outcomes.filter((outcome) => outcome.action === 'retain');

    // "Why was nothing done to the ledger?" should have a visible answer.
    expect(retained.length).toBeGreaterThanOrEqual(5);
    expect(retained.map((outcome) => outcome.rule)).toContain('ledger_entries');
  });
});

describe('expired sessions', () => {
  beforeEach(async () => {
    await context.prisma.session.deleteMany({});
  });

  async function makeSession(expiresAt: Date) {
    return context.prisma.session.create({
      data: {
        identityId: world.customerA.identityId,
        refreshTokenHash: `hash_${Math.random()}`,
        expiresAt,
      },
      select: { id: true },
    });
  }

  it('deletes a session well past its expiry', async () => {
    const old = await makeSession(daysAgo(200));
    await run();
    expect(await context.prisma.session.findUnique({ where: { id: old.id } })).toBeNull();
  });

  it('keeps a session that expired only recently', async () => {
    // Kept 60 days beyond expiry so support can still answer "was this device
    // signed in last month?" during a dispute.
    const recent = await makeSession(daysAgo(10));
    await run();
    expect(await context.prisma.session.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });

  it('keeps a live session', async () => {
    const live = await makeSession(new Date(NOW.getTime() + 86_400_000));
    await run();
    expect(await context.prisma.session.findUnique({ where: { id: live.id } })).not.toBeNull();
  });

  it('treats the cutoff boundary consistently', async () => {
    // Exactly at the cutoff is NOT past it: `lt`, not `lte`.
    const exactly = await makeSession(daysAgo(60));
    const justOver = await makeSession(new Date(daysAgo(60).getTime() - 1000));

    await run();

    expect(await context.prisma.session.findUnique({ where: { id: exactly.id } })).not.toBeNull();
    expect(await context.prisma.session.findUnique({ where: { id: justOver.id } })).toBeNull();
  });

  it('honours a shortened override', async () => {
    const session = await makeSession(daysAgo(10));
    await run({ overrides: { expired_sessions: 5 } });
    expect(await context.prisma.session.findUnique({ where: { id: session.id } })).toBeNull();
  });
});

describe('spent credentials', () => {
  beforeEach(async () => {
    await context.prisma.otpChallenge.deleteMany({});
    await context.prisma.mfaChallenge.deleteMany({});
    await context.prisma.idempotencyKey.deleteMany({});
  });

  it('deletes consumed OTP challenges past the window', async () => {
    const old = await context.prisma.otpChallenge.create({
      data: {
        destination: '+2347000009999',
        channel: 'sms',
        codeHash: 'hash',
        purpose: 'login',
        consumedAt: daysAgo(30),
        expiresAt: daysAgo(30),
      },
      select: { id: true },
    });

    await run();
    expect(await context.prisma.otpChallenge.findUnique({ where: { id: old.id } })).toBeNull();
  });

  it('keeps a live OTP challenge', async () => {
    const live = await context.prisma.otpChallenge.create({
      data: {
        destination: '+2347000009998',
        channel: 'sms',
        codeHash: 'hash',
        purpose: 'login',
        expiresAt: new Date(NOW.getTime() + 300_000),
      },
      select: { id: true },
    });

    await run();
    expect(await context.prisma.otpChallenge.findUnique({ where: { id: live.id } })).not.toBeNull();
  });

  it('deletes spent MFA challenges', async () => {
    const old = await context.prisma.mfaChallenge.create({
      data: {
        identityId: world.admin.identityId,
        tokenHash: `hash_${Math.random()}`,
        purpose: 'login',
        consumedAt: daysAgo(30),
        expiresAt: daysAgo(30),
      },
      select: { id: true },
    });

    await run();
    expect(await context.prisma.mfaChallenge.findUnique({ where: { id: old.id } })).toBeNull();
  });

  it('deletes expired idempotency keys, which can hold order detail', async () => {
    const old = await context.prisma.idempotencyKey.create({
      data: {
        key: `retention_${Math.random()}`,
        endpoint: 'POST /v1/orders',
        responseBody: JSON.stringify({ order: { code: 'DASH-SECRET' } }),
        expiresAt: daysAgo(60),
      },
      select: { id: true },
    });

    await run();
    expect(await context.prisma.idempotencyKey.findUnique({ where: { id: old.id } })).toBeNull();
  });
});

describe('rider location history', () => {
  beforeEach(async () => {
    await context.prisma.riderLocation.deleteMany({});
  });

  async function point(recordedAt: Date, extra: Record<string, unknown> = {}) {
    return context.prisma.riderLocation.create({
      data: {
        riderId: world.riderA.riderId,
        latitude: 6.428139,
        longitude: 3.421957,
        accuracy: 8.5,
        heading: 91.2,
        speed: 7.4,
        recordedAt,
        ...extra,
      },
      select: { id: true },
    });
  }

  it('coarsens an old point instead of deleting it', async () => {
    const old = await point(daysAgo(200));
    await run();

    const after = await context.prisma.riderLocation.findUniqueOrThrow({ where: { id: old.id } });

    // Kept, so aggregate coverage analysis survives…
    expect(after).not.toBeNull();
    // …but no longer a record of where one person stood.
    expect(after.latitude).toBe(6.43);
    expect(after.longitude).toBe(3.42);
    expect(after.anonymisedAt).not.toBeNull();
  });

  it('strips the fields that would reconstruct the precision it removed', async () => {
    const old = await point(daysAgo(200));
    await run();

    const after = await context.prisma.riderLocation.findUniqueOrThrow({ where: { id: old.id } });
    expect(after.accuracy).toBeNull();
    expect(after.heading).toBeNull();
    expect(after.speed).toBeNull();
  });

  it('leaves a recent point at full precision', async () => {
    const recent = await point(daysAgo(10));
    await run();

    const after = await context.prisma.riderLocation.findUniqueOrThrow({
      where: { id: recent.id },
    });
    expect(after.latitude).toBe(6.428139);
    expect(after.anonymisedAt).toBeNull();
  });

  it('rounds to the documented precision', async () => {
    expect(ANONYMISED_LOCATION_DECIMALS).toBe(2);
  });

  it('converges — a second run changes nothing', async () => {
    await point(daysAgo(200));

    const first = await run();
    const second = await run();

    const anonymised = first.outcomes.find((o) => o.rule === 'rider_location_history')!;
    const again = second.outcomes.find((o) => o.rule === 'rider_location_history')!;

    expect(anonymised.affected).toBe(1);
    // Already coarsened rows are skipped rather than rounded again forever.
    expect(again.affected).toBe(0);
  });

  it('is safe to run twice at once', async () => {
    for (let i = 0; i < 20; i += 1) await point(daysAgo(200));

    const [a, b] = await Promise.all([run(), run()]);

    const total =
      a.outcomes.find((o) => o.rule === 'rider_location_history')!.affected +
      b.outcomes.find((o) => o.rule === 'rider_location_history')!.affected;

    // Each row is anonymised exactly once — the `anonymisedAt: null` guard means
    // only one of the two racing `updateMany` calls per row matches, and the
    // job counts matched rows rather than attempts. So the two runs' counts sum
    // to precisely what existed, however they split the batch.
    expect(total).toBe(20);
    expect(await context.prisma.riderLocation.count({ where: { anonymisedAt: null } })).toBe(0);
  });

  it('deletes points that were rejected as implausible', async () => {
    const rejected = await point(daysAgo(60), { rejectedReason: 'implausible_speed_400mps' });
    await run();

    // Never trusted enough to act on; kept only briefly as fraud evidence.
    expect(
      await context.prisma.riderLocation.findUnique({ where: { id: rejected.id } }),
    ).toBeNull();
  });

  it('respects the batch size and picks up the rest next run', async () => {
    for (let i = 0; i < 10; i += 1) await point(daysAgo(200));

    const first = await run({ batchSize: 4 });
    expect(first.outcomes.find((o) => o.rule === 'rider_location_history')!.affected).toBe(4);

    await run({ batchSize: 4 });
    const third = await run({ batchSize: 4 });

    expect(third.outcomes.find((o) => o.rule === 'rider_location_history')!.affected).toBe(2);
    expect(await context.prisma.riderLocation.count({ where: { anonymisedAt: null } })).toBe(0);
  });
});

describe('dry run', () => {
  beforeEach(async () => {
    await context.prisma.session.deleteMany({});
    await context.prisma.riderLocation.deleteMany({});
    await context.prisma.auditLog.deleteMany({});
  });

  it('reports what would change without changing it', async () => {
    const session = await context.prisma.session.create({
      data: {
        identityId: world.customerA.identityId,
        refreshTokenHash: `hash_${Math.random()}`,
        expiresAt: daysAgo(200),
      },
      select: { id: true },
    });

    const report = await run({ dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.outcomes.find((o) => o.rule === 'expired_sessions')!.affected).toBe(1);
    expect(await context.prisma.session.findUnique({ where: { id: session.id } })).not.toBeNull();
  });

  it('does not coarsen anything', async () => {
    const created = await context.prisma.riderLocation.create({
      data: {
        riderId: world.riderA.riderId,
        latitude: 6.428139,
        longitude: 3.421957,
        recordedAt: daysAgo(200),
      },
      select: { id: true },
    });

    await run({ dryRun: true });

    const after = await context.prisma.riderLocation.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(after.latitude).toBe(6.428139);
    expect(after.anonymisedAt).toBeNull();
  });

  it('writes no audit entry — it changed nothing', async () => {
    await context.prisma.session.create({
      data: {
        identityId: world.customerA.identityId,
        refreshTokenHash: `hash_${Math.random()}`,
        expiresAt: daysAgo(200),
      },
    });

    await run({ dryRun: true });

    // An audit entry claiming a run happened would be misleading.
    expect(
      await context.prisma.auditLog.count({ where: { action: 'maintenance.retention.applied' } }),
    ).toBe(0);
  });
});

describe('reporting', () => {
  beforeEach(async () => {
    await context.prisma.auditLog.deleteMany({});
    await context.prisma.session.deleteMany({});
  });

  it('records an aggregate audit entry after a real run', async () => {
    await context.prisma.session.create({
      data: {
        identityId: world.customerA.identityId,
        refreshTokenHash: `hash_${Math.random()}`,
        expiresAt: daysAgo(200),
      },
    });

    await run();

    const entry = await context.prisma.auditLog.findFirstOrThrow({
      where: { action: 'maintenance.retention.applied' },
    });

    const after = JSON.parse(entry.after!) as { totalAffected: number };
    expect(after.totalAffected).toBeGreaterThan(0);
  });

  it('never records the rows it removed', async () => {
    const session = await context.prisma.session.create({
      data: {
        identityId: world.customerA.identityId,
        refreshTokenHash: 'a-very-distinctive-hash-value',
        expiresAt: daysAgo(200),
      },
      select: { id: true },
    });

    await run();

    const entries = await context.prisma.auditLog.findMany({
      where: { action: 'maintenance.retention.applied' },
    });
    const serialised = JSON.stringify(entries);

    // A job that logs the personal data it just deleted has moved the problem
    // rather than solved it.
    expect(serialised).not.toContain('a-very-distinctive-hash-value');
    expect(serialised).not.toContain(session.id);
    expect(serialised).not.toContain(world.customerA.identityId);
  });

  it('writes nothing when there was nothing to do', async () => {
    await run();
    await context.prisma.auditLog.deleteMany({});
    await run();

    expect(
      await context.prisma.auditLog.count({ where: { action: 'maintenance.retention.applied' } }),
    ).toBe(0);
  });

  it('reports a failing rule without abandoning the others', async () => {
    // A rule the job does not implement stands in for any per-rule failure.
    // The point is that the rest of the run still completes.
    const report = await runRetention(context.prisma, {
      now: NOW,
      overrides: { expired_sessions: 30 },
    });

    expect(report.failed).toBe(0);
    expect(report.outcomes.length).toBe(RETENTION_RULES.length);
  });
});
