/**
 * Account deletion — integration tests.
 *
 * The self-service flow (request → cancel → finalise), the staff-on-behalf-of
 * flow, and every adversarial angle the handoff calls out: IDOR on the
 * id-addressed admin routes, replay and repeated requests, a cancellation
 * racing finalisation, concurrent finalisation, and — the invariant the whole
 * feature exists to protect — proof that nothing the ledger references is ever
 * deleted.
 *
 * The 403s and 404s are the point. A green happy path shows the feature works;
 * the denials show it is safe to run.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword, generateReference } from '@dash/domain/crypto';
import { DELETION_COOLING_OFF_DAYS } from '@dash/domain/account';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, idempotencyKey, WORLD_PASSWORD, type Actor, type World } from './world.js';
import {
  cancelAccountDeletion,
  finaliseAccountDeletion,
  requestAccountDeletion,
} from '../account/deletion.js';
import { AccountDeletionError } from '../account/errors.js';
import { runAccountMaintenance } from '../jobs/account-maintenance.js';

let context: TestContext;
let world: World;
let passwordHash: string;

let customerA: Actor;
let customerB: Actor;
let admin: Actor;
let support: Actor;

const DAY_MS = 86_400_000;

beforeAll(async () => {
  // These suites drive a real Fastify + Prisma stack many times over; under a
  // fully parallel `--coverage` run the machine is CPU-starved and a single
  // request can spike well past the 5 s default. Give hooks and tests headroom
  // so a slow machine is not read as a broken feature.
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

  context = await createTestContext();
  world = await buildWorld(context.prisma);
  passwordHash = await hashPassword(WORLD_PASSWORD);
  customerA = await actAs(context, world.customerA.email);
  customerB = await actAs(context, world.customerB.email);
  admin = await actAs(context, world.admin.email);
  support = await actAs(context, world.support.email);

  // Resolve the four fixed identity ids once. `beforeEach` runs before every
  // test; re-querying them each time added ~10 serial round-trips per test.
  for (const email of [
    world.customerA.email,
    world.customerB.email,
    world.admin.email,
    world.support.email,
  ]) {
    await identityIdFor(email);
  }
}, 180_000);

afterAll(async () => {
  await context?.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const prisma = () => context.prisma;

const idCache = new Map<string, string>();

async function identityIdFor(email: string): Promise<string> {
  const hit = idCache.get(email);
  if (hit) return hit;
  const row = await prisma().identity.findFirstOrThrow({ where: { email }, select: { id: true } });
  idCache.set(email, row.id);
  return row.id;
}

/** Complete a step-up by writing `steppedUpAt` on the live session, as payout.test does. */
async function stepUp(email: string): Promise<void> {
  const id = await identityIdFor(email);
  await prisma().session.updateMany({
    where: { identityId: id, revokedAt: null },
    data: { steppedUpAt: new Date() },
  });
}

async function clearStepUp(email: string): Promise<void> {
  const id = await identityIdFor(email);
  await prisma().session.updateMany({ where: { identityId: id }, data: { steppedUpAt: null } });
}

let throwawaySeq = 0;

interface Throwaway {
  identityId: string;
  customerId: string;
  addressId: string;
  email: string;
  phone: string;
}

/**
 * A fresh customer that a test may anonymise without disturbing the shared
 * world. Password-backed so it can also be signed in where a test needs to
 * prove a live session dies at finalisation.
 */
async function makeThrowawayCustomer(tag: string): Promise<Throwaway> {
  throwawaySeq += 1;
  const suffix = `${tag}-${throwawaySeq}-${randomUUID().slice(0, 8)}`;
  const email = `del-${suffix}@dashapp.test`;
  const phone = `+2347005${String(throwawaySeq).padStart(6, '0')}`;

  const identity = await prisma().identity.create({
    data: {
      email,
      phone,
      displayName: `Throwaway ${suffix}`,
      passwordHash,
      roles: { create: { role: 'customer' } },
    },
  });
  const customer = await prisma().customer.create({
    data: {
      identityId: identity.id,
      referralCode: generateReference('REF'),
      dietaryPreferences: JSON.stringify(['halal']),
      marketingOptIn: true,
    },
  });
  const address = await prisma().address.create({
    data: {
      customerId: customer.id,
      label: 'Home',
      line1: `${throwawaySeq} Real Street`,
      landmark: 'by the blue gate',
      instructions: 'call on arrival',
      contactPhone: phone,
      latitude: 6.52,
      longitude: 3.42,
      isDefault: true,
    },
  });
  return {
    identityId: identity.id,
    customerId: customer.id,
    addressId: address.id,
    email,
    phone,
  };
}

/** A delivered order plus its payment and a balanced ledger transaction. */
async function seedFinancialHistory(who: Throwaway): Promise<{
  orderId: string;
  paymentId: string;
  ledgerTxId: string;
  reviewId: string;
  subscriptionId: string;
}> {
  const order = await prisma().order.create({
    data: {
      code: `DASH-${randomUUID().slice(0, 8).toUpperCase()}`,
      customerId: who.customerId,
      vendorId: world.vendorA.vendorId,
      branchId: world.vendorA.branchId,
      addressId: who.addressId,
      status: 'delivered',
      mode: 'delivery',
      itemsSubtotal: 300_000,
      deliveryFee: 40_000,
      serviceFee: 15_000,
      total: 355_000,
      quoteBreakdown: '[]',
      pricingRuleVersion: 'test.1',
      instructions: 'leave at the door — flat 4',
      placedAt: new Date(),
      deliveredAt: new Date(),
      items: {
        create: {
          nameSnapshot: 'A Dish',
          priceSnapshot: 300_000,
          quantity: 1,
          lineTotal: 300_000,
        },
      },
    },
  });

  const payment = await prisma().payment.create({
    data: {
      orderId: order.id,
      provider: 'mock',
      providerReference: `pay_${randomUUID().slice(0, 12)}`,
      amount: 355_000,
      method: 'card',
      status: 'captured',
      idempotencyKey: `pi_${randomUUID().slice(0, 12)}`,
      capturedAt: new Date(),
    },
  });

  const ledgerTx = await prisma().ledgerTransaction.create({
    data: {
      kind: 'order_capture',
      idempotencyKey: `ltx_${randomUUID().slice(0, 12)}`,
      referenceType: 'order',
      referenceId: order.id,
      actorId: 'system',
      occurredAt: new Date(),
      entries: {
        create: [
          { accountKind: 'platform_cash', ownerId: null, amount: 355_000, memo: 'order capture' },
          {
            accountKind: 'customer_wallet',
            ownerId: who.customerId,
            amount: -355_000,
            memo: 'order capture',
          },
        ],
      },
    },
  });

  const review = await prisma().review.create({
    data: {
      orderId: order.id,
      customerId: who.customerId,
      vendorId: world.vendorA.vendorId,
      subject: 'vendor',
      rating: 5,
      comment: 'Great as always — driver was called Sam',
    },
  });

  const subscription = await prisma().subscription.create({
    data: {
      customerId: who.customerId,
      plan: 'dash_plus',
      status: 'active',
      pricePerPeriod: 250_000,
      currentPeriodEnd: new Date(Date.now() + 30 * DAY_MS),
    },
  });

  return {
    orderId: order.id,
    paymentId: payment.id,
    ledgerTxId: ledgerTx.id,
    reviewId: review.id,
    subscriptionId: subscription.id,
  };
}

type HoldKind = 'open_order' | 'payment_dispute' | 'dispute_or_safety_case' | 'outstanding_balance';

/** Create one legal-hold condition for a throwaway customer. Returns how to clear it. */
async function createHoldCondition(
  kind: HoldKind,
  who: Throwaway,
): Promise<{ clear: () => Promise<void> }> {
  switch (kind) {
    case 'open_order': {
      const order = await prisma().order.create({
        data: {
          code: `DASH-${randomUUID().slice(0, 8).toUpperCase()}`,
          customerId: who.customerId,
          vendorId: world.vendorA.vendorId,
          branchId: world.vendorA.branchId,
          status: 'preparing',
          itemsSubtotal: 100_000,
          total: 120_000,
          quoteBreakdown: '[]',
          pricingRuleVersion: 'test.1',
        },
      });
      return {
        clear: async () => {
          await prisma().order.update({
            where: { id: order.id },
            data: { status: 'delivered', deliveredAt: new Date() },
          });
        },
      };
    }
    case 'payment_dispute': {
      const order = await prisma().order.create({
        data: {
          code: `DASH-${randomUUID().slice(0, 8).toUpperCase()}`,
          customerId: who.customerId,
          vendorId: world.vendorA.vendorId,
          branchId: world.vendorA.branchId,
          status: 'delivered',
          itemsSubtotal: 100_000,
          total: 120_000,
          quoteBreakdown: '[]',
          pricingRuleVersion: 'test.1',
        },
      });
      const payment = await prisma().payment.create({
        data: {
          orderId: order.id,
          provider: 'mock',
          providerReference: `pay_${randomUUID().slice(0, 12)}`,
          amount: 120_000,
          method: 'card',
          status: 'captured',
          idempotencyKey: `pi_${randomUUID().slice(0, 12)}`,
        },
      });
      const refund = await prisma().refund.create({
        data: {
          paymentId: payment.id,
          amount: 120_000,
          reason: 'complaint',
          status: 'disputed',
          idempotencyKey: `rf_${randomUUID().slice(0, 12)}`,
          requestedBy: who.identityId,
        },
      });
      return {
        clear: async () => {
          await prisma().refund.update({
            where: { id: refund.id },
            data: { status: 'approved', approvedAt: new Date() },
          });
        },
      };
    }
    case 'dispute_or_safety_case': {
      const supportCase = await prisma().supportCase.create({
        data: {
          code: `SC-${randomUUID().slice(0, 8).toUpperCase()}`,
          customerId: who.customerId,
          subject: 'safety concern',
          category: 'safety',
          status: 'open',
        },
      });
      return {
        clear: async () => {
          await prisma().supportCase.update({
            where: { id: supportCase.id },
            data: { status: 'resolved', resolvedAt: new Date() },
          });
        },
      };
    }
    case 'outstanding_balance': {
      await prisma().ledgerTransaction.create({
        data: {
          kind: 'adjustment',
          idempotencyKey: `ltx_${randomUUID().slice(0, 12)}`,
          referenceType: 'manual',
          referenceId: who.customerId,
          actorId: 'system',
          occurredAt: new Date(),
          entries: {
            create: [
              { accountKind: 'customer_wallet', ownerId: who.customerId, amount: 50_000, memo: 'debt' },
              { accountKind: 'platform_cash', ownerId: null, amount: -50_000, memo: 'debt' },
            ],
          },
        },
      });
      return {
        clear: async () => {
          // An offsetting transaction — the ledger is append-only.
          await prisma().ledgerTransaction.create({
            data: {
              kind: 'adjustment',
              idempotencyKey: `ltx_${randomUUID().slice(0, 12)}`,
              referenceType: 'manual',
              referenceId: who.customerId,
              actorId: 'system',
              occurredAt: new Date(),
              entries: {
                create: [
                  {
                    accountKind: 'customer_wallet',
                    ownerId: who.customerId,
                    amount: -50_000,
                    memo: 'settled',
                  },
                  { accountKind: 'platform_cash', ownerId: null, amount: 50_000, memo: 'settled' },
                ],
              },
            },
          });
        },
      };
    }
  }
}

const postDeletion = (actor: Actor, opts: { key?: string; reason?: string } = {}) =>
  context.app.inject({
    method: 'POST',
    url: '/v1/account/deletion',
    headers: { ...actor.headers, 'idempotency-key': opts.key ?? idempotencyKey('del') },
    payload: opts.reason === undefined ? {} : { reason: opts.reason },
  });

const getDeletion = (actor: Actor) =>
  context.app.inject({ method: 'GET', url: '/v1/account/deletion', headers: actor.headers });

const deleteDeletion = (actor: Actor) =>
  context.app.inject({ method: 'DELETE', url: '/v1/account/deletion', headers: actor.headers });

const adminPost = (actor: Actor, id: string, reason: unknown) =>
  context.app.inject({
    method: 'POST',
    url: `/v1/admin/identities/${id}/deletion`,
    headers: actor.headers,
    payload: reason === undefined ? {} : { reason },
  });

beforeEach(async () => {
  // Lean and parallel: one `deleteMany`, one `updateMany` to drop any deletion
  // row and clear step-up for all three shared identities in a single round of
  // queries, so the hook cannot itself become the slow thing under load.
  const idA = await identityIdFor(world.customerA.email);
  const idB = await identityIdFor(world.customerB.email);
  const idAdmin = await identityIdFor(world.admin.email);
  await Promise.all([
    prisma().accountDeletionRequest.deleteMany({ where: { identityId: { in: [idA, idB] } } }),
    prisma().session.updateMany({
      where: { identityId: { in: [idA, idB, idAdmin] } },
      data: { steppedUpAt: null },
    }),
  ]);
  await prisma().identity.updateMany({
    where: { id: { in: [idA, idB] } },
    data: { deletionRequestedAt: null, anonymisedAt: null },
  });
});

// ---------------------------------------------------------------------------
describe('POST /v1/account/deletion — authorization', () => {
  it('requires a fresh step-up', async () => {
    const response = await postDeletion(customerA);
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('step_up_required');

    const id = await identityIdFor(world.customerA.email);
    expect(await prisma().accountDeletionRequest.count({ where: { identityId: id } })).toBe(0);
  });

  it('rejects a stale step-up', async () => {
    const id = await identityIdFor(world.customerA.email);
    await prisma().session.updateMany({
      where: { identityId: id, revokedAt: null },
      data: { steppedUpAt: new Date(Date.now() - 3_600_000) }, // an hour ago; window is 15m
    });
    const response = await postDeletion(customerA);
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('step_up_required');
  });

  it('refuses a caller that is not a customer', async () => {
    // support_agent holds no `account:delete:own`.
    const response = await postDeletion(support);
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('forbidden');
  });

  it('requires an Idempotency-Key', async () => {
    await stepUp(world.customerA.email);
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/account/deletion',
      headers: customerA.headers,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe('POST /v1/account/deletion — scheduling', () => {
  it('schedules a deletion a cooling-off window out and records it', async () => {
    await stepUp(world.customerA.email);
    const before = Date.now();
    const response = await postDeletion(customerA, { reason: 'moving abroad' });
    expect(response.statusCode).toBe(200);

    const { deletion } = response.json<{
      deletion: {
        status: string;
        requestedAt: string;
        scheduledPurgeAt: string;
        cancellable: boolean;
      };
    }>();
    expect(deletion.status).toBe('scheduled');
    expect(deletion.cancellable).toBe(true);

    const purgeAt = new Date(deletion.scheduledPurgeAt).getTime();
    const expected = before + DELETION_COOLING_OFF_DAYS * DAY_MS;
    expect(Math.abs(purgeAt - expected)).toBeLessThan(5 * 60_000);

    const id = await identityIdFor(world.customerA.email);
    const row = await prisma().accountDeletionRequest.findUniqueOrThrow({
      where: { identityId: id },
    });
    expect(row.status).toBe('scheduled');
    expect(row.reason).toBe('moving abroad'); // reason lives on the row, not the audit log

    const identity = await prisma().identity.findUniqueOrThrow({ where: { id } });
    expect(identity.deletionRequestedAt).not.toBeNull();

    const audit = await prisma().auditLog.findFirstOrThrow({
      where: { action: 'account.deletion.requested', resourceId: id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit.after).not.toBeNull();
    const after = JSON.parse(audit.after!) as Record<string, unknown>;
    expect(after).toMatchObject({ hasReason: true, coolingOffDays: DELETION_COOLING_OFF_DAYS });
    expect(audit.after).not.toContain('moving abroad');
  });

  it('is idempotent on replay of the same key', async () => {
    await stepUp(world.customerA.email);
    const key = idempotencyKey('del-replay');
    const first = await postDeletion(customerA, { key });
    const second = await postDeletion(customerA, { key });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);

    const id = await identityIdFor(world.customerA.email);
    expect(await prisma().accountDeletionRequest.count({ where: { identityId: id } })).toBe(1);
  });

  it('a second request with a new key returns the existing schedule without resetting the clock', async () => {
    await stepUp(world.customerA.email);
    const first = await postDeletion(customerA);
    const firstBody = first.json<{ deletion: { requestedAt: string; scheduledPurgeAt: string } }>();

    await new Promise((r) => setTimeout(r, 10));
    const second = await postDeletion(customerA);
    const secondBody = second.json<{
      deletion: { requestedAt: string; scheduledPurgeAt: string };
    }>();

    expect(second.statusCode).toBe(200);
    expect(secondBody.deletion.requestedAt).toBe(firstBody.deletion.requestedAt);
    expect(secondBody.deletion.scheduledPurgeAt).toBe(firstBody.deletion.scheduledPurgeAt);

    const id = await identityIdFor(world.customerA.email);
    expect(await prisma().accountDeletionRequest.count({ where: { identityId: id } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('legal holds block acceptance', () => {
  it('an active order holds the request', async () => {
    const who = await makeThrowawayCustomer('hold-order');
    await prisma().order.create({
      data: {
        code: `DASH-${randomUUID().slice(0, 8).toUpperCase()}`,
        customerId: who.customerId,
        vendorId: world.vendorA.vendorId,
        branchId: world.vendorA.branchId,
        status: 'preparing',
        itemsSubtotal: 100_000,
        total: 120_000,
        quoteBreakdown: '[]',
        pricingRuleVersion: 'test.1',
      },
    });

    await expect(
      requestAccountDeletion(prisma(), {
        identityId: who.identityId,
        customerId: who.customerId,
        requestedBy: who.identityId,
        coolingOffDays: DELETION_COOLING_OFF_DAYS,
      }),
    ).rejects.toMatchObject({ reason: 'legal_hold', details: { hold: 'open_order' } });

    expect(
      await prisma().accountDeletionRequest.count({ where: { identityId: who.identityId } }),
    ).toBe(0);
  });

  it('an unresolved refund holds the request', async () => {
    const who = await makeThrowawayCustomer('hold-refund');
    const order = await prisma().order.create({
      data: {
        code: `DASH-${randomUUID().slice(0, 8).toUpperCase()}`,
        customerId: who.customerId,
        vendorId: world.vendorA.vendorId,
        branchId: world.vendorA.branchId,
        status: 'delivered',
        itemsSubtotal: 100_000,
        total: 120_000,
        quoteBreakdown: '[]',
        pricingRuleVersion: 'test.1',
      },
    });
    const payment = await prisma().payment.create({
      data: {
        orderId: order.id,
        provider: 'mock',
        providerReference: `pay_${randomUUID().slice(0, 12)}`,
        amount: 120_000,
        method: 'card',
        status: 'captured',
        idempotencyKey: `pi_${randomUUID().slice(0, 12)}`,
      },
    });
    await prisma().refund.create({
      data: {
        paymentId: payment.id,
        amount: 120_000,
        reason: 'complaint',
        status: 'disputed',
        idempotencyKey: `rf_${randomUUID().slice(0, 12)}`,
        requestedBy: who.identityId,
      },
    });

    await expect(
      requestAccountDeletion(prisma(), {
        identityId: who.identityId,
        customerId: who.customerId,
        requestedBy: who.identityId,
        coolingOffDays: DELETION_COOLING_OFF_DAYS,
      }),
    ).rejects.toMatchObject({ reason: 'legal_hold', details: { hold: 'payment_dispute' } });
  });

  it('an open safety/dispute case holds the request', async () => {
    const who = await makeThrowawayCustomer('hold-case');
    await prisma().supportCase.create({
      data: {
        code: `SC-${randomUUID().slice(0, 8).toUpperCase()}`,
        customerId: who.customerId,
        subject: 'safety concern',
        category: 'safety',
        status: 'open',
      },
    });

    await expect(
      requestAccountDeletion(prisma(), {
        identityId: who.identityId,
        customerId: who.customerId,
        requestedBy: who.identityId,
        coolingOffDays: DELETION_COOLING_OFF_DAYS,
      }),
    ).rejects.toMatchObject({ reason: 'legal_hold', details: { hold: 'dispute_or_safety_case' } });
  });

  it('a negative wallet balance holds the request', async () => {
    const who = await makeThrowawayCustomer('hold-owes');
    await prisma().ledgerTransaction.create({
      data: {
        kind: 'adjustment',
        idempotencyKey: `ltx_${randomUUID().slice(0, 12)}`,
        referenceType: 'manual',
        referenceId: who.customerId,
        actorId: 'system',
        occurredAt: new Date(),
        entries: {
          create: [
            {
              accountKind: 'customer_wallet',
              ownerId: who.customerId,
              amount: 50_000,
              memo: 'debt',
            },
            { accountKind: 'platform_cash', ownerId: null, amount: -50_000, memo: 'debt' },
          ],
        },
      },
    });

    await expect(
      requestAccountDeletion(prisma(), {
        identityId: who.identityId,
        customerId: who.customerId,
        requestedBy: who.identityId,
        coolingOffDays: DELETION_COOLING_OFF_DAYS,
      }),
    ).rejects.toMatchObject({ reason: 'legal_hold', details: { hold: 'outstanding_balance' } });
  });

  it('surfaces the hold as a 409 with a machine-readable code over HTTP', async () => {
    await stepUp(world.customerA.email);
    const order = await prisma().order.create({
      data: {
        code: `DASH-${randomUUID().slice(0, 8).toUpperCase()}`,
        customerId: world.customerA.customerId,
        vendorId: world.vendorA.vendorId,
        branchId: world.vendorA.branchId,
        status: 'placed',
        itemsSubtotal: 100_000,
        total: 120_000,
        quoteBreakdown: '[]',
        pricingRuleVersion: 'test.1',
      },
    });
    try {
      const response = await postDeletion(customerA);
      expect(response.statusCode).toBe(409);
      const { error } = response.json<{ error: { code: string; details?: { hold?: string } } }>();
      expect(error.code).toBe('legal_hold');
      expect(error.details?.hold).toBe('open_order');
    } finally {
      await prisma().order.delete({ where: { id: order.id } });
    }
  });
});

// ---------------------------------------------------------------------------
describe('legal holds re-checked at finalisation', () => {
  const cases: { kind: HoldKind; label: string }[] = [
    { kind: 'open_order', label: 'an order placed during the cooling-off window' },
    { kind: 'payment_dispute', label: 'a refund dispute opened during the cooling-off window' },
    { kind: 'dispute_or_safety_case', label: 'a safety case opened during the cooling-off window' },
    { kind: 'outstanding_balance', label: 'a wallet run negative during the cooling-off window' },
  ];

  for (const { kind, label } of cases) {
    it(`parks finalisation in "held" when ${label} appears after scheduling`, async () => {
      const who = await makeThrowawayCustomer(`resurface-${kind}`);
      // Clean at request time, so the request itself succeeds.
      await requestAccountDeletion(prisma(), {
        identityId: who.identityId,
        customerId: who.customerId,
        requestedBy: who.identityId,
        coolingOffDays: DELETION_COOLING_OFF_DAYS,
      });

      // The hold appears only now — after scheduling, before the window closes.
      await createHoldCondition(kind, who);

      const dueNow = new Date(Date.now() + (DELETION_COOLING_OFF_DAYS + 1) * DAY_MS);
      const result = await finaliseAccountDeletion(prisma(), {
        identityId: who.identityId,
        idempotencyKey: `fin_${randomUUID()}`,
        now: dueNow,
      });

      expect(result.alreadyDone).toBe(false);
      expect(result.held).toBe(true);
      expect(result.heldReason).toBe(kind);

      // Nothing was anonymised or completed.
      const identity = await prisma().identity.findUniqueOrThrow({ where: { id: who.identityId } });
      expect(identity.anonymisedAt).toBeNull();
      expect(identity.email).toBe(who.email);
      expect(identity.passwordHash).not.toBeNull();

      const request = await prisma().accountDeletionRequest.findUniqueOrThrow({
        where: { identityId: who.identityId },
      });
      expect(request.status).toBe('held');
      expect(request.heldReason).toBe(kind);
      expect(request.completedAt).toBeNull();

      const audit = await prisma().auditLog.findFirstOrThrow({
        where: { action: 'account.deletion.held', resourceId: who.identityId },
      });
      const after = JSON.parse(audit.after!) as { hold: string };
      expect(after.hold).toBe(kind);
      // Non-sensitive: the hold code only, nothing that names the person or the
      // matter in detail.
      expect(audit.after).not.toContain(who.email.split('@')[0]);
    });
  }

  it('resumes and finalises automatically once the hold clears, and audits the resume', async () => {
    const who = await makeThrowawayCustomer('resume');
    await requestAccountDeletion(prisma(), {
      identityId: who.identityId,
      customerId: who.customerId,
      requestedBy: who.identityId,
      coolingOffDays: DELETION_COOLING_OFF_DAYS,
    });
    const { clear } = await createHoldCondition('open_order', who);
    const dueNow = new Date(Date.now() + (DELETION_COOLING_OFF_DAYS + 1) * DAY_MS);

    const held = await finaliseAccountDeletion(prisma(), {
      identityId: who.identityId,
      idempotencyKey: `fin_${randomUUID()}`,
      now: dueNow,
    });
    expect(held.held).toBe(true);

    await clear();

    const resumed = await finaliseAccountDeletion(prisma(), {
      identityId: who.identityId,
      idempotencyKey: `fin_${randomUUID()}`,
      now: dueNow,
    });
    expect(resumed.alreadyDone).toBe(false);
    expect(resumed.held).toBeFalsy();

    const identity = await prisma().identity.findUniqueOrThrow({ where: { id: who.identityId } });
    expect(identity.anonymisedAt).not.toBeNull();

    const request = await prisma().accountDeletionRequest.findUniqueOrThrow({
      where: { identityId: who.identityId },
    });
    expect(request.status).toBe('completed');

    await prisma().auditLog.findFirstOrThrow({
      where: { action: 'account.deletion.resumed', resourceId: who.identityId },
    });
    await prisma().auditLog.findFirstOrThrow({
      where: { action: 'account.deletion.completed', resourceId: who.identityId },
    });
  });

  it('writes one held audit while the same hold persists across repeated runs', async () => {
    const who = await makeThrowawayCustomer('held-quiet-retry');
    await requestAccountDeletion(prisma(), {
      identityId: who.identityId,
      customerId: who.customerId,
      requestedBy: who.identityId,
      coolingOffDays: DELETION_COOLING_OFF_DAYS,
    });
    await createHoldCondition('open_order', who);
    const dueNow = new Date(Date.now() + (DELETION_COOLING_OFF_DAYS + 1) * DAY_MS);

    await finaliseAccountDeletion(prisma(), {
      identityId: who.identityId,
      idempotencyKey: `fin_${randomUUID()}`,
      now: dueNow,
    });
    await finaliseAccountDeletion(prisma(), {
      identityId: who.identityId,
      idempotencyKey: `fin_${randomUUID()}`,
      now: dueNow,
    });

    expect(
      await prisma().auditLog.count({
        where: { action: 'account.deletion.held', resourceId: who.identityId },
      }),
    ).toBe(1);
  });

  it('a held request is still cancellable by its owner', async () => {
    const who = await makeThrowawayCustomer('held-cancel');
    await requestAccountDeletion(prisma(), {
      identityId: who.identityId,
      customerId: who.customerId,
      requestedBy: who.identityId,
      coolingOffDays: DELETION_COOLING_OFF_DAYS,
    });
    await createHoldCondition('open_order', who);
    const dueNow = new Date(Date.now() + (DELETION_COOLING_OFF_DAYS + 1) * DAY_MS);
    await finaliseAccountDeletion(prisma(), {
      identityId: who.identityId,
      idempotencyKey: `fin_${randomUUID()}`,
      now: dueNow,
    });

    const view = await cancelAccountDeletion(prisma(), {
      identityId: who.identityId,
      cancelledBy: who.identityId,
      now: dueNow,
    });
    expect(view.status).toBe('cancelled');

    const identity = await prisma().identity.findUniqueOrThrow({ where: { id: who.identityId } });
    expect(identity.anonymisedAt).toBeNull();
  });

  it('the maintenance run counts held separately and resumes it once clear', async () => {
    const who = await makeThrowawayCustomer('mnt-held');
    const now = new Date();
    await prisma().accountDeletionRequest.create({
      data: {
        identityId: who.identityId,
        status: 'scheduled',
        requestedAt: new Date(now.getTime() - 20 * DAY_MS),
        scheduledPurgeAt: new Date(now.getTime() - DAY_MS),
        requestedBy: who.identityId,
      },
    });
    const { clear } = await createHoldCondition('open_order', who);

    const first = await runAccountMaintenance(prisma(), context.app.services.exportArchive, { now });
    expect(first.deletions.held).toBeGreaterThanOrEqual(1);
    expect(first.deletions.finalised).toBe(0);

    let identity = await prisma().identity.findUniqueOrThrow({ where: { id: who.identityId } });
    expect(identity.anonymisedAt).toBeNull();
    let request = await prisma().accountDeletionRequest.findUniqueOrThrow({
      where: { identityId: who.identityId },
    });
    expect(request.status).toBe('held');

    await clear();

    const second = await runAccountMaintenance(prisma(), context.app.services.exportArchive, { now });
    expect(second.deletions.finalised).toBeGreaterThanOrEqual(1);

    identity = await prisma().identity.findUniqueOrThrow({ where: { id: who.identityId } });
    expect(identity.anonymisedAt).not.toBeNull();
    request = await prisma().accountDeletionRequest.findUniqueOrThrow({
      where: { identityId: who.identityId },
    });
    expect(request.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
describe('GET / DELETE /v1/account/deletion', () => {
  it('reports no deletion when none is scheduled', async () => {
    const response = await getDeletion(customerA);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ deletion: null }>().deletion).toBeNull();
  });

  it('cancels a scheduled deletion without a step-up and clears the flag', async () => {
    await stepUp(world.customerA.email);
    await postDeletion(customerA);
    await clearStepUp(world.customerA.email); // cancellation must not need one

    const response = await deleteDeletion(customerA);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ deletion: { status: string } }>().deletion.status).toBe('cancelled');

    const id = await identityIdFor(world.customerA.email);
    const identity = await prisma().identity.findUniqueOrThrow({ where: { id } });
    expect(identity.deletionRequestedAt).toBeNull();

    const status = await getDeletion(customerA);
    const body = status.json<{ deletion: { status: string; cancellable: boolean } }>();
    expect(body.deletion.status).toBe('cancelled');
    expect(body.deletion.cancellable).toBe(false);

    await prisma().auditLog.findFirstOrThrow({
      where: { action: 'account.deletion.cancelled', resourceId: id },
    });
  });

  it('a re-request after cancellation starts a fresh window', async () => {
    await stepUp(world.customerA.email);
    const first = await postDeletion(customerA);
    const firstAt = first.json<{ deletion: { requestedAt: string } }>().deletion.requestedAt;
    await deleteDeletion(customerA);

    await new Promise((r) => setTimeout(r, 10));
    await stepUp(world.customerA.email);
    const second = await postDeletion(customerA);
    expect(second.statusCode).toBe(200);
    const secondBody = second.json<{ deletion: { status: string; requestedAt: string } }>();
    expect(secondBody.deletion.status).toBe('scheduled');
    expect(new Date(secondBody.deletion.requestedAt).getTime()).toBeGreaterThan(
      new Date(firstAt).getTime(),
    );

    const id = await identityIdFor(world.customerA.email);
    expect(await prisma().accountDeletionRequest.count({ where: { identityId: id } })).toBe(1);
  });

  it('rejects DELETE for a non-customer', async () => {
    const response = await deleteDeletion(support);
    expect(response.statusCode).toBe(403);
  });

  it('returns 404 when there is nothing to cancel', async () => {
    const response = await deleteDeletion(customerA);
    expect(response.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('IDOR — the self-service routes only ever act on the caller', () => {
  it('customer B requesting deletion never touches customer A', async () => {
    await stepUp(world.customerB.email);
    const response = await postDeletion(customerB);
    expect(response.statusCode).toBe(200);

    const idA = await identityIdFor(world.customerA.email);
    expect(await prisma().accountDeletionRequest.count({ where: { identityId: idA } })).toBe(0);
  });

  it("customer B cannot see or cancel customer A's scheduled deletion", async () => {
    await stepUp(world.customerA.email);
    await postDeletion(customerA);

    const seen = await getDeletion(customerB);
    expect(seen.json<{ deletion: null }>().deletion).toBeNull();

    const cancelled = await deleteDeletion(customerB);
    expect(cancelled.statusCode).toBe(404);

    const idA = await identityIdFor(world.customerA.email);
    const row = await prisma().accountDeletionRequest.findUniqueOrThrow({
      where: { identityId: idA },
    });
    expect(row.status).toBe('scheduled');
  });
});

// ---------------------------------------------------------------------------
describe('staff on-behalf-of flow', () => {
  it('refuses a caller without admin:account:delete', async () => {
    const idA = await identityIdFor(world.customerA.email);
    const response = await adminPost(support, idA, 'policy violation review');
    expect(response.statusCode).toBe(403);
  });

  it('requires a step-up even for an admin', async () => {
    const idA = await identityIdFor(world.customerA.email);
    const response = await adminPost(admin, idA, 'policy violation review');
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('step_up_required');
  });

  it('requires a reason of real length', async () => {
    await stepUp(world.admin.email);
    const idA = await identityIdFor(world.customerA.email);

    expect((await adminPost(admin, idA, undefined)).statusCode).toBe(400);
    expect((await adminPost(admin, idA, 'too short')).statusCode).toBe(400);
  });

  it("schedules on the customer's behalf with an on-behalf-of audit entry", async () => {
    await stepUp(world.admin.email);
    const idA = await identityIdFor(world.customerA.email);
    const adminIdentityId = await identityIdFor(world.admin.email);

    const response = await adminPost(admin, idA, 'confirmed account takeover — ticket 4821');
    expect(response.statusCode).toBe(200);
    expect(response.json<{ deletion: { status: string } }>().deletion.status).toBe('scheduled');

    const row = await prisma().accountDeletionRequest.findUniqueOrThrow({
      where: { identityId: idA },
    });
    expect(row.status).toBe('scheduled');
    expect(row.reason).toBe('confirmed account takeover — ticket 4821');

    const audit = await prisma().auditLog.findFirstOrThrow({
      where: { action: 'account.deletion.requested', resourceId: idA, onBehalfOf: idA },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit.identityId).toBe(adminIdentityId);
    expect(audit.onBehalfOf).toBe(idA);
    expect(audit.after).not.toContain('ticket 4821');

    const cancelled = await context.app.inject({
      method: 'DELETE',
      url: `/v1/admin/identities/${idA}/deletion`,
      headers: admin.headers,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<{ deletion: { status: string } }>().deletion.status).toBe('cancelled');
  });

  it('gives the same 404 for a missing identity and for a non-customer — no oracle', async () => {
    await stepUp(world.admin.email);
    const supportIdentityId = await identityIdFor(world.support.email);

    const missing = await adminPost(admin, `id_${randomUUID()}`, 'a properly long reason here');
    const notACustomer = await adminPost(admin, supportIdentityId, 'a properly long reason here');

    expect(missing.statusCode).toBe(404);
    expect(notACustomer.statusCode).toBe(404);
    expect(missing.json<{ error: { message: string } }>().error.message).toBe(
      notACustomer.json<{ error: { message: string } }>().error.message,
    );
  });
});

// ---------------------------------------------------------------------------
describe('finalisation — anonymise, never delete what the ledger references', () => {
  it('refuses to finalise before the cooling-off window closes', async () => {
    const who = await makeThrowawayCustomer('not-due');
    await requestAccountDeletion(prisma(), {
      identityId: who.identityId,
      customerId: who.customerId,
      requestedBy: who.identityId,
      coolingOffDays: DELETION_COOLING_OFF_DAYS,
    });

    await expect(
      finaliseAccountDeletion(prisma(), {
        identityId: who.identityId,
        idempotencyKey: `fin_${randomUUID()}`,
        now: new Date(),
      }),
    ).rejects.toMatchObject({ reason: 'not_due' });

    const identity = await prisma().identity.findUniqueOrThrow({ where: { id: who.identityId } });
    expect(identity.anonymisedAt).toBeNull();
  });

  it('clears personal fields, deletes credentials, and leaves every financial row intact', async () => {
    const who = await makeThrowawayCustomer('finalise');
    const seeded = await seedFinancialHistory(who);

    await prisma().session.create({
      data: {
        identityId: who.identityId,
        refreshTokenHash: `hash_${randomUUID()}`,
        expiresAt: new Date(Date.now() + 30 * DAY_MS),
      },
    });
    await prisma().device.create({
      data: { identityId: who.identityId, platform: 'ios', pushToken: `tok_${randomUUID()}` },
    });
    await prisma().cart.create({ data: { customerId: who.customerId } });
    const supportCase = await prisma().supportCase.create({
      data: {
        code: `SC-${randomUUID().slice(0, 8).toUpperCase()}`,
        customerId: who.customerId,
        subject: 'where is my order',
        category: 'general',
        status: 'resolved',
        resolvedAt: new Date(),
      },
    });
    await prisma().supportAction.create({
      data: {
        caseId: supportCase.id,
        actorId: who.identityId,
        kind: 'reply',
        body: 'My phone number is in the address, please call',
      },
    });

    await requestAccountDeletion(prisma(), {
      identityId: who.identityId,
      customerId: who.customerId,
      requestedBy: who.identityId,
      coolingOffDays: DELETION_COOLING_OFF_DAYS,
    });

    const result = await finaliseAccountDeletion(prisma(), {
      identityId: who.identityId,
      idempotencyKey: `fin_${randomUUID()}`,
      now: new Date(Date.now() + (DELETION_COOLING_OFF_DAYS + 1) * DAY_MS),
    });
    expect(result.alreadyDone).toBe(false);

    // --- Identity anonymised ------------------------------------------------
    const identity = await prisma().identity.findUniqueOrThrow({ where: { id: who.identityId } });
    expect(identity.email).toBe(`deleted+${who.identityId}@deleted.dashapp.invalid`);
    expect(identity.phone).toBeNull();
    expect(identity.passwordHash).toBeNull();
    expect(identity.displayName).toBe('Deleted account');
    expect(identity.status).toBe('deleted');
    expect(identity.anonymisedAt).not.toBeNull();

    // --- Credentials and drafts gone -------------------------------------
    expect(await prisma().session.count({ where: { identityId: who.identityId } })).toBe(0);
    expect(await prisma().device.count({ where: { identityId: who.identityId } })).toBe(0);
    expect(await prisma().cart.count({ where: { customerId: who.customerId } })).toBe(0);

    // --- Ledger / orders / payments: same rows, same numbers ------------
    const order = await prisma().order.findUniqueOrThrow({ where: { id: seeded.orderId } });
    expect(order.total).toBe(355_000);
    expect(order.customerId).toBe(who.customerId);
    expect(order.instructions).toBeNull(); // the only field that clears

    expect(await prisma().orderItem.count({ where: { orderId: seeded.orderId } })).toBe(1);

    const payment = await prisma().payment.findUniqueOrThrow({ where: { id: seeded.paymentId } });
    expect(payment.amount).toBe(355_000);
    expect(payment.status).toBe('captured');

    const entries = await prisma().ledgerEntry.findMany({
      where: { transactionId: seeded.ledgerTxId },
      orderBy: { amount: 'asc' },
    });
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.amount)).toEqual([-355_000, 355_000]);
    expect(entries.reduce((sum, e) => sum + e.amount, 0)).toBe(0);

    const review = await prisma().review.findUniqueOrThrow({ where: { id: seeded.reviewId } });
    expect(review.rating).toBe(5); // aggregate must not shift
    expect(review.comment).toBeNull();

    expect(await prisma().subscription.count({ where: { id: seeded.subscriptionId } })).toBe(1);

    // --- Address anonymised in place -----------------------------------
    const address = await prisma().address.findUniqueOrThrow({ where: { id: who.addressId } });
    expect(address.line1).toBe('[deleted]');
    expect(address.contactPhone).toBe('[deleted]');
    expect(address.latitude).toBe(0);
    expect(address.longitude).toBe(0);

    // --- Support history scrubbed but kept ----------------------------
    const action = await prisma().supportAction.findFirstOrThrow({
      where: { caseId: supportCase.id },
    });
    expect(action.body).toBe('[deleted]');

    // --- Customer profile scrubbed -----------------------------------
    const customer = await prisma().customer.findUniqueOrThrow({ where: { id: who.customerId } });
    expect(customer.dietaryPreferences).toBeNull();
    expect(customer.marketingOptIn).toBe(false);

    // --- Audit: counts only, never PII -----------------------------
    const completed = await prisma().auditLog.findFirstOrThrow({
      where: { action: 'account.deletion.completed', resourceId: who.identityId },
    });
    const after = JSON.parse(completed.after!) as { counts: Record<string, number> };
    expect(after.counts.Session).toBe(1);
    expect(after.counts.Order).toBe(1);

    const allAudits = await prisma().auditLog.findMany({
      where: { OR: [{ resourceId: who.identityId }, { identityId: who.identityId }] },
    });
    const localPart = who.email.split('@')[0]!;
    for (const entry of allAudits) {
      const blob = `${entry.before ?? ''}${entry.after ?? ''}`;
      expect(blob).not.toContain(localPart);
      expect(blob).not.toContain(who.phone);
    }
  });

  it('is idempotent: a second finalisation is a no-op and writes no second completed audit', async () => {
    const who = await makeThrowawayCustomer('finalise-twice');
    const seeded = await seedFinancialHistory(who);
    await requestAccountDeletion(prisma(), {
      identityId: who.identityId,
      customerId: who.customerId,
      requestedBy: who.identityId,
      coolingOffDays: DELETION_COOLING_OFF_DAYS,
    });
    const when = new Date(Date.now() + (DELETION_COOLING_OFF_DAYS + 1) * DAY_MS);

    const first = await finaliseAccountDeletion(prisma(), {
      identityId: who.identityId,
      idempotencyKey: `fin_${randomUUID()}`,
      now: when,
    });
    const second = await finaliseAccountDeletion(prisma(), {
      identityId: who.identityId,
      idempotencyKey: `fin_${randomUUID()}`,
      now: when,
    });

    expect(first.alreadyDone).toBe(false);
    expect(second.alreadyDone).toBe(true);

    expect(
      await prisma().auditLog.count({
        where: { action: 'account.deletion.completed', resourceId: who.identityId },
      }),
    ).toBe(1);

    const entries = await prisma().ledgerEntry.findMany({
      where: { transactionId: seeded.ledgerTxId },
    });
    expect(entries).toHaveLength(2);
  });

  it('concurrent finalisation anonymises exactly once', async () => {
    const who = await makeThrowawayCustomer('finalise-race');
    const seeded = await seedFinancialHistory(who);
    await requestAccountDeletion(prisma(), {
      identityId: who.identityId,
      customerId: who.customerId,
      requestedBy: who.identityId,
      coolingOffDays: DELETION_COOLING_OFF_DAYS,
    });
    const when = new Date(Date.now() + (DELETION_COOLING_OFF_DAYS + 1) * DAY_MS);

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        finaliseAccountDeletion(prisma(), {
          identityId: who.identityId,
          idempotencyKey: `fin_${randomUUID()}`,
          now: when,
        }),
      ),
    );

    // Exactly one call did the anonymisation; the rest were no-ops (or lost the
    // write race and rejected). Either way the account is anonymised once.
    const winners = results.filter(
      (r) => r.status === 'fulfilled' && r.value.alreadyDone === false,
    );
    expect(winners).toHaveLength(1);

    expect(
      await prisma().auditLog.count({
        where: { action: 'account.deletion.completed', resourceId: who.identityId },
      }),
    ).toBe(1);

    const entries = await prisma().ledgerEntry.findMany({
      where: { transactionId: seeded.ledgerTxId },
    });
    expect(entries).toHaveLength(2);
  });

  it('a cancellation that beats finalisation wins: the account is never anonymised', async () => {
    const who = await makeThrowawayCustomer('cancel-then-finalise');
    await requestAccountDeletion(prisma(), {
      identityId: who.identityId,
      customerId: who.customerId,
      requestedBy: who.identityId,
      coolingOffDays: DELETION_COOLING_OFF_DAYS,
    });
    await cancelAccountDeletion(prisma(), {
      identityId: who.identityId,
      cancelledBy: who.identityId,
    });

    const result = await finaliseAccountDeletion(prisma(), {
      identityId: who.identityId,
      idempotencyKey: `fin_${randomUUID()}`,
      now: new Date(Date.now() + 365 * DAY_MS),
    });
    expect(result.alreadyDone).toBe(true);

    const identity = await prisma().identity.findUniqueOrThrow({ where: { id: who.identityId } });
    expect(identity.anonymisedAt).toBeNull();
    expect(identity.email).toBe(who.email);

    const request = await prisma().accountDeletionRequest.findUniqueOrThrow({
      where: { identityId: who.identityId },
    });
    expect(request.status).toBe('cancelled');
  });

  it('a cancellation that arrives after finalisation is refused', async () => {
    const who = await makeThrowawayCustomer('finalise-then-cancel');
    await requestAccountDeletion(prisma(), {
      identityId: who.identityId,
      customerId: who.customerId,
      requestedBy: who.identityId,
      coolingOffDays: DELETION_COOLING_OFF_DAYS,
    });
    await finaliseAccountDeletion(prisma(), {
      identityId: who.identityId,
      idempotencyKey: `fin_${randomUUID()}`,
      now: new Date(Date.now() + (DELETION_COOLING_OFF_DAYS + 1) * DAY_MS),
    });

    await expect(
      cancelAccountDeletion(prisma(), {
        identityId: who.identityId,
        cancelledBy: who.identityId,
      }),
    ).rejects.toBeInstanceOf(AccountDeletionError);
  });

  it('a request after completion is refused', async () => {
    const who = await makeThrowawayCustomer('request-after-done');
    await requestAccountDeletion(prisma(), {
      identityId: who.identityId,
      customerId: who.customerId,
      requestedBy: who.identityId,
      coolingOffDays: DELETION_COOLING_OFF_DAYS,
    });
    await finaliseAccountDeletion(prisma(), {
      identityId: who.identityId,
      idempotencyKey: `fin_${randomUUID()}`,
      now: new Date(Date.now() + (DELETION_COOLING_OFF_DAYS + 1) * DAY_MS),
    });

    await expect(
      requestAccountDeletion(prisma(), {
        identityId: who.identityId,
        customerId: who.customerId,
        requestedBy: who.identityId,
        coolingOffDays: DELETION_COOLING_OFF_DAYS,
      }),
    ).rejects.toMatchObject({ reason: 'already_completed' });
  });

  it('a live session stops working the moment the account is finalised', async () => {
    const who = await makeThrowawayCustomer('session-dies');
    const client = await actAs(context, who.email);

    const before = await context.app.inject({
      method: 'GET',
      url: '/v1/account/deletion',
      headers: client.headers,
    });
    expect(before.statusCode).toBe(200);

    await requestAccountDeletion(prisma(), {
      identityId: who.identityId,
      customerId: who.customerId,
      requestedBy: who.identityId,
      coolingOffDays: DELETION_COOLING_OFF_DAYS,
    });
    await finaliseAccountDeletion(prisma(), {
      identityId: who.identityId,
      idempotencyKey: `fin_${randomUUID()}`,
      now: new Date(Date.now() + (DELETION_COOLING_OFF_DAYS + 1) * DAY_MS),
    });

    const after = await context.app.inject({
      method: 'GET',
      url: '/v1/account/deletion',
      headers: client.headers,
    });
    expect(after.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe('runAccountMaintenance', () => {
  it('finalises due deletions and leaves future ones alone', async () => {
    const due = await makeThrowawayCustomer('mnt-due');
    const future = await makeThrowawayCustomer('mnt-future');
    const now = new Date();

    await prisma().accountDeletionRequest.create({
      data: {
        identityId: due.identityId,
        status: 'scheduled',
        requestedAt: new Date(now.getTime() - 20 * DAY_MS),
        scheduledPurgeAt: new Date(now.getTime() - DAY_MS),
        requestedBy: due.identityId,
      },
    });
    await prisma().identity.update({
      where: { id: due.identityId },
      data: { deletionRequestedAt: new Date(now.getTime() - 20 * DAY_MS) },
    });
    await prisma().accountDeletionRequest.create({
      data: {
        identityId: future.identityId,
        status: 'scheduled',
        requestedAt: now,
        scheduledPurgeAt: new Date(now.getTime() + 5 * DAY_MS),
        requestedBy: future.identityId,
      },
    });

    const report = await runAccountMaintenance(prisma(), context.app.services.exportArchive, {
      now,
    });
    expect(report.deletions.finalised).toBeGreaterThanOrEqual(1);

    const dueIdentity = await prisma().identity.findUniqueOrThrow({ where: { id: due.identityId } });
    expect(dueIdentity.anonymisedAt).not.toBeNull();

    const futureIdentity = await prisma().identity.findUniqueOrThrow({
      where: { id: future.identityId },
    });
    expect(futureIdentity.anonymisedAt).toBeNull();

    const second = await runAccountMaintenance(prisma(), context.app.services.exportArchive, {
      now,
    });
    const stillOne = await prisma().auditLog.count({
      where: { action: 'account.deletion.completed', resourceId: due.identityId },
    });
    expect(stillOne).toBe(1);
    expect(second.deletions.failed).toBe(0);
  });

  it('a dry run writes nothing', async () => {
    const due = await makeThrowawayCustomer('mnt-dry');
    const now = new Date();
    await prisma().accountDeletionRequest.create({
      data: {
        identityId: due.identityId,
        status: 'scheduled',
        requestedAt: new Date(now.getTime() - 20 * DAY_MS),
        scheduledPurgeAt: new Date(now.getTime() - DAY_MS),
        requestedBy: due.identityId,
      },
    });

    const report = await runAccountMaintenance(prisma(), context.app.services.exportArchive, {
      now,
      dryRun: true,
    });
    expect(report.dryRun).toBe(true);
    expect(report.deletions.due).toBeGreaterThanOrEqual(1);

    const identity = await prisma().identity.findUniqueOrThrow({ where: { id: due.identityId } });
    expect(identity.anonymisedAt).toBeNull();
  });
});
