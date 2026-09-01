/**
 * Personal-data export — integration tests.
 *
 * request → build → status → download, and the adversarial cases the handoff
 * names: IDOR on both the status route and the download, a replayed / wrong
 * token, a second download of a single-use link, concurrent downloads, an
 * expired link, and a build failure that must not wedge the queue. The archive
 * is also checked for the one property that matters most — it contains the
 * requester's data and nobody else's.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword, generateReference } from '@dash/domain/crypto';
import { EXPORT_BUILD_MAX_ATTEMPTS } from '@dash/domain/account';
import type { ExportArchivePort, QueuePort, QueueJob } from '@dash/domain/ports';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, idempotencyKey, WORLD_PASSWORD, type Actor, type World } from './world.js';
import {
  buildDataExport,
  consumeDataExportDownload,
  requestDataExport,
  signDownloadToken,
} from '../account/export.js';
import { runAccountMaintenance } from '../jobs/account-maintenance.js';

/** Records enqueues and never runs them, so the build step is driven explicitly. */
class RecordingQueue implements QueuePort {
  readonly providerName = 'recording';
  readonly enqueued: { name: string; payload: unknown; idempotencyKey?: string }[] = [];

  async enqueue<T>(input: {
    name: string;
    payload: T;
    delayMs?: number | undefined;
    idempotencyKey?: string | undefined;
    maxAttempts?: number | undefined;
  }): Promise<{ jobId: string }> {
    this.enqueued.push({
      name: input.name,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
    });
    return { jobId: `rec_${randomUUID()}` };
  }

  process<T>(_name: string, _handler: (job: QueueJob<T>) => Promise<void>): void {
    // Intentionally inert.
  }

  async close(): Promise<void> {
    // Nothing to drain.
  }

  buildJobsFor(requestId: string): typeof this.enqueued {
    return this.enqueued.filter(
      (j) => j.name === 'account.export.build' && (j.payload as { requestId?: string }).requestId === requestId,
    );
  }
}

let context: TestContext;
let world: World;
let queue: RecordingQueue;
let passwordHash: string;

let customerA: Actor;
let customerB: Actor;
let support: Actor;

const HOUR_MS = 3_600_000;

beforeAll(async () => {
  // A fully parallel `--coverage` run starves the machine; give hooks and tests
  // headroom so a slow request is not misread as a broken feature.
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

  queue = new RecordingQueue();
  context = await createTestContext({}, { queue });
  world = await buildWorld(context.prisma);
  passwordHash = await hashPassword(WORLD_PASSWORD);
  customerA = await actAs(context, world.customerA.email);
  customerB = await actAs(context, world.customerB.email);
  support = await actAs(context, world.support.email);

  for (const email of [world.customerA.email, world.customerB.email, world.support.email]) {
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
const archive = (): ExportArchivePort => context.app.services.exportArchive;
const ttlHours = () => context.config.DATA_EXPORT_TTL_HOURS;
const downloadSecret = () => `account-export-download.${context.config.JWT_ACCESS_SECRET}`;

const idCache = new Map<string, string>();

async function identityIdFor(email: string): Promise<string> {
  const hit = idCache.get(email);
  if (hit) return hit;
  const row = await prisma().identity.findFirstOrThrow({ where: { email }, select: { id: true } });
  idCache.set(email, row.id);
  return row.id;
}

async function stepUp(email: string): Promise<void> {
  const id = await identityIdFor(email);
  await prisma().session.updateMany({
    where: { identityId: id, revokedAt: null },
    data: { steppedUpAt: new Date() },
  });
}

/** Drop export rows and their archives for the shared identities, cheaply. */
async function resetSharedExports(): Promise<void> {
  const idA = await identityIdFor(world.customerA.email);
  const idB = await identityIdFor(world.customerB.email);
  const rows = await prisma().dataExportRequest.findMany({
    where: { identityId: { in: [idA, idB] } },
    select: { storageKey: true },
  });
  await Promise.all([
    ...rows.map((row) =>
      row.storageKey ? archive().delete(row.storageKey).catch(() => undefined) : Promise.resolve(),
    ),
    prisma().session.updateMany({
      where: { identityId: { in: [idA, idB] } },
      data: { steppedUpAt: null },
    }),
  ]);
  await prisma().dataExportRequest.deleteMany({ where: { identityId: { in: [idA, idB] } } });
}

let seq = 0;

interface Throwaway {
  identityId: string;
  customerId: string;
  email: string;
  phone: string;
}

async function makeThrowawayCustomer(tag: string): Promise<Throwaway> {
  seq += 1;
  const suffix = `${tag}-${seq}-${randomUUID().slice(0, 8)}`;
  const email = `exp-${suffix}@dashapp.test`;
  const phone = `+2347006${String(seq).padStart(6, '0')}`;
  const identity = await prisma().identity.create({
    data: {
      email,
      phone,
      displayName: `Exporter ${suffix}`,
      locale: 'en-NG',
      passwordHash,
      roles: { create: { role: 'customer' } },
    },
  });
  const customer = await prisma().customer.create({
    data: {
      identityId: identity.id,
      referralCode: generateReference('REF'),
      marketingOptIn: true,
    },
  });
  return { identityId: identity.id, customerId: customer.id, email, phone };
}

async function seedOrder(customerId: string, code: string): Promise<void> {
  await prisma().order.create({
    data: {
      code,
      customerId,
      vendorId: world.vendorA.vendorId,
      branchId: world.vendorA.branchId,
      status: 'delivered',
      itemsSubtotal: 200_000,
      total: 240_000,
      quoteBreakdown: '[]',
      pricingRuleVersion: 'test.1',
      deliveredAt: new Date(),
      items: {
        create: { nameSnapshot: 'A Dish', priceSnapshot: 200_000, quantity: 1, lineTotal: 200_000 },
      },
    },
  });
}

/** Wrap the real archive, substituting behaviour for one method at a time. */
function wrapArchive(overrides: Partial<ExportArchivePort> = {}): ExportArchivePort {
  const base = archive();
  return {
    providerName: base.providerName,
    isLive: base.isLive,
    write: overrides.write ?? base.write.bind(base),
    read: overrides.read ?? base.read.bind(base),
    delete: overrides.delete ?? base.delete.bind(base),
  };
}

/** Create a pending row and build it. Returns the ready row id and its archive key. */
async function makeReadyExport(who: Throwaway): Promise<{ id: string; storageKey: string }> {
  const { jobRequestId } = await requestDataExport(prisma(), { identityId: who.identityId });
  const id = jobRequestId!;
  const result = await buildDataExport(prisma(), archive(), { requestId: id, ttlHours: ttlHours() });
  expect(result.status).toBe('ready');
  const row = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });
  return { id, storageKey: row.storageKey! };
}

const postExport = (actor: Actor, key = idempotencyKey('exp')) =>
  context.app.inject({
    method: 'POST',
    url: '/v1/account/export',
    headers: { ...actor.headers, 'idempotency-key': key },
  });

const getExport = (actor: Actor, id: string) =>
  context.app.inject({ method: 'GET', url: `/v1/account/export/${id}`, headers: actor.headers });

const listExports = (actor: Actor) =>
  context.app.inject({ method: 'GET', url: '/v1/account/export', headers: actor.headers });

const download = (actor: Actor, id: string, token: string) =>
  context.app.inject({
    method: 'GET',
    url: `/v1/account/export/${id}/download?token=${encodeURIComponent(token)}`,
    headers: actor.headers,
  });

beforeEach(async () => {
  queue.enqueued.length = 0;
  await resetSharedExports();
});

// ---------------------------------------------------------------------------
describe('POST /v1/account/export', () => {
  it('requires a fresh step-up', async () => {
    const response = await postExport(customerA);
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('step_up_required');
  });

  it('refuses a caller that is not a customer', async () => {
    const response = await postExport(support);
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('forbidden');
  });

  it('requires an Idempotency-Key', async () => {
    await stepUp(world.customerA.email);
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/account/export',
      headers: customerA.headers,
    });
    expect(response.statusCode).toBe(400);
  });

  it('creates a pending request, writes an audit with no PII, and enqueues one build', async () => {
    await stepUp(world.customerA.email);
    const response = await postExport(customerA);
    expect(response.statusCode).toBe(200);

    const { export: view } = response.json<{ export: { id: string; status: string } }>();
    expect(view.status).toBe('pending');

    const row = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id: view.id } });
    expect(row.status).toBe('pending');
    expect(row.downloadCount).toBe(0);

    const audit = await prisma().auditLog.findFirstOrThrow({
      where: { action: 'account.export.requested', resourceId: view.id },
    });
    expect(audit.after).toBeNull(); // request audit carries no payload at all

    const jobs = queue.buildJobsFor(view.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.idempotencyKey).toBe(`export_build_${view.id}`);
  });

  it('keeps one outstanding request at a time', async () => {
    await stepUp(world.customerA.email);
    const first = await postExport(customerA, idempotencyKey('exp-a'));
    const second = await postExport(customerA, idempotencyKey('exp-b'));

    const firstId = first.json<{ export: { id: string } }>().export.id;
    const secondId = second.json<{ export: { id: string } }>().export.id;
    expect(secondId).toBe(firstId);

    const id = await identityIdFor(world.customerA.email);
    expect(await prisma().dataExportRequest.count({ where: { identityId: id } })).toBe(1);
    // The second call must not have queued another archive build.
    expect(queue.buildJobsFor(firstId)).toHaveLength(1);
  });

  it('is idempotent on replay of the same key', async () => {
    await stepUp(world.customerA.email);
    const key = idempotencyKey('exp-replay');
    const first = await postExport(customerA, key);
    const second = await postExport(customerA, key);
    expect(second.body).toBe(first.body);
  });
});

// ---------------------------------------------------------------------------
describe('build', () => {
  it('produces a ready archive with an expiry, a size, and a ready audit', async () => {
    const who = await makeThrowawayCustomer('build');
    const { jobRequestId } = await requestDataExport(prisma(), { identityId: who.identityId });
    const id = jobRequestId!;
    const now = new Date();

    const result = await buildDataExport(prisma(), archive(), {
      requestId: id,
      ttlHours: ttlHours(),
      now,
    });
    expect(result.status).toBe('ready');

    const row = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('ready');
    expect(row.readyAt).not.toBeNull();
    expect(row.sizeBytes).toBeGreaterThan(0);
    expect(row.storageKey).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(row.expiresAt!.getTime() - now.getTime()).toBeCloseTo(ttlHours() * HOUR_MS, -4);

    await prisma().auditLog.findFirstOrThrow({
      where: { action: 'account.export.ready', resourceId: id },
    });

    // The bytes are really there.
    const bytes = await archive().read(row.storageKey!);
    expect(bytes.length).toBe(row.sizeBytes);
  });

  it('the archive contains the requester data and nobody else\'s', async () => {
    const mine = await makeThrowawayCustomer('archive-mine');
    const other = await makeThrowawayCustomer('archive-other');
    await seedOrder(mine.customerId, 'DASH-MINE-01');
    await seedOrder(other.customerId, 'DASH-OTHER-01');

    const { storageKey } = await makeReadyExport(mine);
    const doc = JSON.parse((await archive().read(storageKey)).toString('utf8')) as {
      manifest: { subjectId: string; notice: string; sections: string[] };
      profile: { email: string; phone: string };
      orders: { code: string }[];
    };

    expect(doc.manifest.subjectId).toBe(mine.identityId);
    expect(doc.manifest.notice.toLowerCase()).toContain("other users");
    expect(doc.profile.email).toBe(mine.email);
    expect(doc.profile.phone).toBe(mine.phone);

    const codes = doc.orders.map((o) => o.code);
    expect(codes).toContain('DASH-MINE-01');
    expect(codes).not.toContain('DASH-OTHER-01');
  });

  it('is idempotent: a second build returns the ready row untouched', async () => {
    const who = await makeThrowawayCustomer('build-twice');
    const { id, storageKey } = await makeReadyExport(who);
    const readyAt = (await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } })).readyAt;

    const again = await buildDataExport(prisma(), archive(), { requestId: id, ttlHours: ttlHours() });
    expect(again.status).toBe('ready');

    const row = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });
    expect(row.readyAt).toEqual(readyAt);
    expect(row.storageKey).toBe(storageKey);
  });

  it('a build failure marks the request failed with a bounded reason and does not throw', async () => {
    const who = await makeThrowawayCustomer('build-fail');
    const { jobRequestId } = await requestDataExport(prisma(), { identityId: who.identityId });
    const id = jobRequestId!;

    const brokenArchive: ExportArchivePort = {
      providerName: 'broken',
      isLive: false,
      write: async () => {
        throw new Error(`disk is on fire ${'and '.repeat(200)}`);
      },
      read: async () => Buffer.from(''),
      delete: async () => undefined,
    };

    const result = await buildDataExport(prisma(), brokenArchive, { requestId: id, ttlHours: ttlHours() });
    expect(result.status).toBe('failed');

    const row = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('failed');
    expect(row.failedAt).not.toBeNull();
    expect(row.failureReason).toBeTruthy();
    expect(row.failureReason!.length).toBeLessThanOrEqual(200);

    await prisma().auditLog.findFirstOrThrow({
      where: { action: 'account.export.failed', resourceId: id },
    });
  });

  it('concurrent builds: exactly one worker claims, writes, and wins', async () => {
    const who = await makeThrowawayCustomer('build-race');
    const { jobRequestId } = await requestDataExport(prisma(), { identityId: who.identityId });
    const id = jobRequestId!;

    let writeCount = 0;
    const counting = wrapArchive({
      write: async (input) => {
        writeCount += 1;
        return archive().write(input);
      },
    });

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        buildDataExport(prisma(), counting, { requestId: id, ttlHours: ttlHours() }),
      ),
    );
    const fulfilled = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    expect(fulfilled).toHaveLength(4);

    // Exactly one worker actually built it; the rest lost the claim and wrote
    // nothing — `skipped` on all of them, and only one archive write happened.
    const winners = fulfilled.filter((r) => r.status === 'ready' && !r.skipped);
    expect(winners).toHaveLength(1);
    expect(fulfilled.filter((r) => r.skipped)).toHaveLength(3);
    expect(writeCount).toBe(1);

    const row = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('ready');
  });

  it('a database failure after a successful write cleans up the blob it wrote', async () => {
    const who = await makeThrowawayCustomer('build-db-fail');
    const { jobRequestId } = await requestDataExport(prisma(), { identityId: who.identityId });
    const id = jobRequestId!;

    let stolenKey: string | null = null;
    const sabotaged = wrapArchive({
      write: async (input) => {
        const result = await archive().write(input);
        stolenKey = input.key;
        // Simulate the claim being stolen the instant after the blob is
        // written — e.g. the promotion update lost a race or the database
        // blipped. The commit that follows must find its claim gone.
        await prisma().dataExportRequest.updateMany({
          where: { id },
          data: {
            buildClaimId: `stolen_${randomUUID()}`,
            buildClaimUntil: new Date(Date.now() + 60_000),
          },
        });
        return result;
      },
    });

    const result = await buildDataExport(prisma(), sabotaged, { requestId: id, ttlHours: ttlHours() });
    expect(result.skipped).toBe(true);

    expect(stolenKey).not.toBeNull();
    // The blob this worker wrote does not orphan.
    await expect(archive().read(stolenKey!)).rejects.toBeTruthy();
  });

  it('a stale build claim is reclaimed and completed by a later call', async () => {
    const who = await makeThrowawayCustomer('build-stale-reclaim');
    const { jobRequestId } = await requestDataExport(prisma(), { identityId: who.identityId });
    const id = jobRequestId!;

    // Simulate an abandoned worker: claimed, never finished, claim now stale.
    await prisma().dataExportRequest.update({
      where: { id },
      data: {
        status: 'building',
        buildClaimId: `dead_${randomUUID()}`,
        buildClaimUntil: new Date(Date.now() - 1000),
        buildAttempts: 1,
      },
    });

    const result = await buildDataExport(prisma(), archive(), { requestId: id, ttlHours: ttlHours() });
    expect(result.status).toBe('ready');
    expect(result.skipped).toBeFalsy();

    const row = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('ready');
    expect(row.buildAttempts).toBe(2);
  });

  it('a stale build claim abandoned past recovery is failed by maintenance and its blob dropped', async () => {
    const who = await makeThrowawayCustomer('build-stale-mnt');
    const staleKey = `stale_${randomUUID().replace(/-/g, '')}`;
    await archive().write({
      key: staleKey,
      body: Buffer.from('{"orphan":true}'),
      contentType: 'application/json',
    });

    const row = await prisma().dataExportRequest.create({
      data: {
        identityId: who.identityId,
        status: 'building',
        buildClaimId: `abandoned_${randomUUID()}`,
        buildClaimUntil: new Date(Date.now() - 60_000),
        buildAttempts: 1,
        storageKey: staleKey,
      },
    });

    const report = await runAccountMaintenance(prisma(), archive(), { now: new Date() });
    expect(report.exports.staleBuildsFailed).toBeGreaterThanOrEqual(1);

    const after = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('failed');
    expect(after.storageKey).toBeNull();
    expect(after.buildClaimId).toBeNull();
    await expect(archive().read(staleKey)).rejects.toBeTruthy();

    await prisma().auditLog.findFirstOrThrow({
      where: { action: 'account.export.failed', resourceId: row.id },
    });
  });

  it('fails a request that has exceeded the maximum build attempts, without writing again', async () => {
    const who = await makeThrowawayCustomer('build-max-attempts');
    const { jobRequestId } = await requestDataExport(prisma(), { identityId: who.identityId });
    const id = jobRequestId!;
    await prisma().dataExportRequest.update({
      where: { id },
      data: { buildAttempts: EXPORT_BUILD_MAX_ATTEMPTS },
    });

    let wrote = false;
    const spied = wrapArchive({
      write: async (input) => {
        wrote = true;
        return archive().write(input);
      },
    });

    const result = await buildDataExport(prisma(), spied, { requestId: id, ttlHours: ttlHours() });
    expect(result.status).toBe('failed');
    expect(wrote).toBe(false);

    const row = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
describe('GET /v1/account/export(/:id)', () => {
  it('hands back a signed download capability while ready and unread', async () => {
    const who = await makeThrowawayCustomer('status-token');
    const client = await actAs(context, who.email);
    const { id } = await makeReadyExport(who);

    const response = await getExport(client, id);
    expect(response.statusCode).toBe(200);
    const { export: view } = response.json<{ export: { status: string; downloadToken?: string } }>();
    expect(view.status).toBe('ready');
    expect(view.downloadToken).toBeTruthy();
    expect(view.downloadToken!.split('.')).toHaveLength(3);
  });

  it('the list view never carries a token', async () => {
    const who = await makeThrowawayCustomer('status-list');
    const client = await actAs(context, who.email);
    await makeReadyExport(who);

    const response = await listExports(client);
    const { exports } = response.json<{ exports: Record<string, unknown>[] }>();
    expect(exports.length).toBeGreaterThanOrEqual(1);
    for (const row of exports) expect(row).not.toHaveProperty('downloadToken');
  });

  it('IDOR: another customer gets a 404 for a status they do not own', async () => {
    const who = await makeThrowawayCustomer('status-idor');
    const { id } = await makeReadyExport(who);

    const response = await getExport(customerB, id);
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
describe('GET /v1/account/export/:id/download', () => {
  it('streams the archive once, then refuses the second attempt', async () => {
    const who = await makeThrowawayCustomer('dl-once');
    const client = await actAs(context, who.email);
    const { id, storageKey } = await makeReadyExport(who);

    const token = (await getExport(client, id)).json<{ export: { downloadToken: string } }>().export
      .downloadToken;

    const first = await download(client, id, token);
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toContain('application/json');
    expect(String(first.headers['content-disposition'])).toContain(
      `filename="dash-app-export-${id}.json"`,
    );
    expect(String(first.headers['cache-control'])).toContain('no-store');
    expect(() => JSON.parse(first.body)).not.toThrow();

    const row = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('delivered');
    expect(row.downloadCount).toBe(1);
    expect(row.deliveredAt).not.toBeNull();
    expect(row.storageKey).toBeNull();

    // Archive really gone.
    await expect(archive().read(storageKey)).rejects.toBeTruthy();

    await prisma().auditLog.findFirstOrThrow({
      where: { action: 'account.export.downloaded', resourceId: id },
    });

    const second = await download(client, id, token);
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: { code: string } }>().error.code).toBe('already_downloaded');
  });

  it('IDOR: another customer cannot download with a valid token', async () => {
    const who = await makeThrowawayCustomer('dl-idor');
    const client = await actAs(context, who.email);
    const { id } = await makeReadyExport(who);
    const token = (await getExport(client, id)).json<{ export: { downloadToken: string } }>().export
      .downloadToken;

    const response = await download(customerB, id, token);
    expect(response.statusCode).toBe(404);

    const row = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('ready');
    expect(row.downloadCount).toBe(0);
  });

  it('a garbage token is a 404, not an oracle, and does not consume the export', async () => {
    const who = await makeThrowawayCustomer('dl-badtoken');
    const client = await actAs(context, who.email);
    const { id } = await makeReadyExport(who);

    const response = await download(client, id, 'not.a.token');
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('not_found');

    const row = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('ready');
    expect(row.downloadCount).toBe(0);
  });

  it('a token minted for another request is rejected', async () => {
    const who = await makeThrowawayCustomer('dl-wrongreq');
    const client = await actAs(context, who.email);
    const { id } = await makeReadyExport(who);
    const row = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });

    // A structurally valid token, correctly signed, but for a different id.
    const wrongToken = signDownloadToken(downloadSecret(), `other_${randomUUID()}`, row.expiresAt!);

    const response = await download(client, id, wrongToken);
    expect(response.statusCode).toBe(404);

    const after = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });
    expect(after.downloadCount).toBe(0);
  });

  it('concurrent downloads: exactly one wins', async () => {
    const who = await makeThrowawayCustomer('dl-race');
    const client = await actAs(context, who.email);
    const { id } = await makeReadyExport(who);
    const token = (await getExport(client, id)).json<{ export: { downloadToken: string } }>().export
      .downloadToken;

    const results = await Promise.allSettled([
      download(client, id, token),
      download(client, id, token),
      download(client, id, token),
    ]);
    const codes = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.statusCode] : []));

    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(2);

    const row = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });
    expect(row.downloadCount).toBe(1);
  });

  it('an expired link is refused and its archive is cleaned up', async () => {
    const who = await makeThrowawayCustomer('dl-expired');
    const { id, storageKey } = await makeReadyExport(who);
    const row = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });
    const token = signDownloadToken(downloadSecret(), id, row.expiresAt!);
    const wellPast = new Date(row.expiresAt!.getTime() + HOUR_MS);

    await expect(
      consumeDataExportDownload(prisma(), archive(), {
        requestId: id,
        identityId: who.identityId,
        token,
        downloadSecret: downloadSecret(),
        now: wellPast,
      }),
    ).rejects.toMatchObject({ reason: 'expired' });

    const after = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe('expired');
    expect(after.storageKey).toBeNull();
    await expect(archive().read(storageKey)).rejects.toBeTruthy();
  });

  it('a storage read failure leaves the export retryable — no delivery, no lease left behind', async () => {
    const who = await makeThrowawayCustomer('dl-read-fail');
    const { id, storageKey } = await makeReadyExport(who);
    const row = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });
    const token = signDownloadToken(downloadSecret(), id, row.expiresAt!);

    const flaky = wrapArchive({
      read: async () => {
        throw new Error('temporary storage outage');
      },
    });

    await expect(
      consumeDataExportDownload(prisma(), flaky, {
        requestId: id,
        identityId: who.identityId,
        token,
        downloadSecret: downloadSecret(),
      }),
    ).rejects.toMatchObject({ reason: 'storage_unavailable' });

    const afterFailure = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });
    expect(afterFailure.status).toBe('ready');
    expect(afterFailure.downloadCount).toBe(0);
    expect(afterFailure.downloadLeaseId).toBeNull();
    expect(afterFailure.storageKey).toBe(storageKey);

    // Retry against real storage succeeds — the failure did not burn the
    // single permitted download.
    const result = await consumeDataExportDownload(prisma(), archive(), {
      requestId: id,
      identityId: who.identityId,
      token,
      downloadSecret: downloadSecret(),
    });
    expect(result.body.length).toBeGreaterThan(0);

    const afterRetry = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });
    expect(afterRetry.status).toBe('delivered');
    expect(afterRetry.downloadCount).toBe(1);
  });

  it('concurrent reads: exactly one delivers even when the loser reads first', async () => {
    const who = await makeThrowawayCustomer('dl-concurrent-reads');
    const { id } = await makeReadyExport(who);
    const row = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });
    const token = signDownloadToken(downloadSecret(), id, row.expiresAt!);

    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        consumeDataExportDownload(prisma(), archive(), {
          requestId: id,
          identityId: who.identityId,
          token,
          downloadSecret: downloadSecret(),
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);

    const after = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe('delivered');
    expect(after.downloadCount).toBe(1);
  });

  it('a delete failure after a successful download is retried by the maintenance sweep', async () => {
    const who = await makeThrowawayCustomer('dl-cleanup-fail');
    const { id, storageKey } = await makeReadyExport(who);
    const row = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });
    const token = signDownloadToken(downloadSecret(), id, row.expiresAt!);

    const noDelete = wrapArchive({
      delete: async () => {
        throw new Error('storage delete failed');
      },
    });

    const result = await consumeDataExportDownload(prisma(), noDelete, {
      requestId: id,
      identityId: who.identityId,
      token,
      downloadSecret: downloadSecret(),
    });
    expect(result.body.length).toBeGreaterThan(0);

    const afterDownload = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });
    expect(afterDownload.status).toBe('delivered');
    // The delete failed, so the key is deliberately left in place — the row is
    // the record that cleanup is still owed.
    expect(afterDownload.storageKey).toBe(storageKey);
    await expect(archive().read(storageKey)).resolves.toBeInstanceOf(Buffer);

    const report = await runAccountMaintenance(prisma(), archive(), { now: new Date() });
    expect(report.exports.orphansCleaned).toBeGreaterThanOrEqual(1);

    const cleaned = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });
    expect(cleaned.storageKey).toBeNull();
    await expect(archive().read(storageKey)).rejects.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('maintenance sweep of stale exports', () => {
  it('expires ready archives past their window and deletes the bytes', async () => {
    const who = await makeThrowawayCustomer('sweep');
    const { id, storageKey } = await makeReadyExport(who);

    // Backdate the expiry.
    await prisma().dataExportRequest.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - HOUR_MS) },
    });

    const { runAccountMaintenance } = await import('../jobs/account-maintenance.js');
    const report = await runAccountMaintenance(prisma(), archive(), { now: new Date() });
    expect(report.exports.expired).toBeGreaterThanOrEqual(1);
    expect(report.exports.failed).toBe(0);

    const row = await prisma().dataExportRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('expired');
    expect(row.storageKey).toBeNull();
    await expect(archive().read(storageKey)).rejects.toBeTruthy();
  });
});
