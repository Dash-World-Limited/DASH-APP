/**
 * Personal-data export — the work behind the routes and the build job.
 *
 * The shape:
 *
 *   request   → a DataExportRequest row, status `pending`, and a queued job
 *   build     → the job: gather the subject's own data into one JSON archive,
 *               store it via ExportArchivePort, set status `ready` with an
 *               expiry
 *   status    → an authenticated route the owner polls; while the archive is
 *               ready and unread it hands back a signed, expiring download
 *               capability
 *   download  → an authenticated route: verify the capability, then a
 *               `downloadCount: 0` guard makes the download single-use; the
 *               archive is deleted immediately after
 *
 * The download capability is a signed token, not a stored secret. It carries
 * the request id and an expiry and is verified by HMAC, so nothing about it
 * needs to live in the database — the single-use property is enforced by the
 * row's `downloadCount`, and the "authorisation" is the signature plus the
 * fact that only the authenticated owner is ever handed one.
 *
 * What the archive contains: only data the requesting person supplied or
 * generated. What it never contains: other people's data, internal risk
 * scoring, staff identities, operational notes, or anything secret. That
 * boundary is stated inside the archive's manifest.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { generateToken } from '@dash/domain/crypto';
import {
  assertExportTransition,
  EXPORT_BUILD_CLAIM_SECONDS,
  EXPORT_BUILD_MAX_ATTEMPTS,
  EXPORT_DOWNLOAD_LEASE_SECONDS,
  exportExpiresAt,
  exportManifest,
  isDownloadable,
  type ExportStatus,
} from '@dash/domain/account';
import type { ExportArchivePort } from '@dash/domain/ports';
import { writeAudit, type PrismaClient } from '@dash/db';
import { DataExportError } from './errors.js';

const ARCHIVE_CONTENT_TYPE = 'application/json';

// ---------------------------------------------------------------------------
// Download capability token
// ---------------------------------------------------------------------------

/** Domain separation, so this HMAC can never be confused with another use of the same secret. */
const TOKEN_CONTEXT = 'dash.account.export.download.v1';

/** `<requestId>.<expEpochSeconds>.<hmacHex>` */
export function signDownloadToken(secret: string, requestId: string, expiresAt: Date): string {
  const exp = Math.floor(expiresAt.getTime() / 1000);
  const body = `${requestId}.${exp}`;
  const mac = createHmac('sha256', `${TOKEN_CONTEXT}.${secret}`).update(body).digest('hex');
  return `${body}.${mac}`;
}

export function verifyDownloadToken(
  secret: string,
  token: string,
  expectedRequestId: string,
  now: Date,
): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [requestId, expRaw, macHex] = parts as [string, string, string];

  if (requestId !== expectedRequestId) return false;

  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp * 1000 <= now.getTime()) return false;

  const expected = createHmac('sha256', `${TOKEN_CONTEXT}.${secret}`)
    .update(`${requestId}.${exp}`)
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(macHex, 'hex');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface ExportRequestView {
  readonly id: string;
  readonly status: ExportStatus;
  readonly requestedAt: Date;
  readonly readyAt: Date | null;
  readonly expiresAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly sizeBytes: number | null;
  /** A signed, expiring download capability. Present only while downloadable. */
  readonly downloadToken?: string;
}

interface ExportRow {
  id: string;
  status: string;
  requestedAt: Date;
  readyAt: Date | null;
  expiresAt: Date | null;
  deliveredAt: Date | null;
  sizeBytes: number | null;
  downloadCount: number;
}

function toView(row: ExportRow, now: Date, downloadSecret?: string): ExportRequestView {
  const status = row.status as ExportStatus;
  const view: ExportRequestView = {
    id: row.id,
    status,
    requestedAt: row.requestedAt,
    readyAt: row.readyAt,
    expiresAt: row.expiresAt,
    deliveredAt: row.deliveredAt,
    sizeBytes: row.sizeBytes,
  };
  if (
    downloadSecret &&
    row.expiresAt &&
    isDownloadable({ status, expiresAt: row.expiresAt, downloadCount: row.downloadCount }, now)
  ) {
    return { ...view, downloadToken: signDownloadToken(downloadSecret, row.id, row.expiresAt) };
  }
  return view;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Create a pending export request and hand back a job payload.
 *
 * One `pending` or `ready` request per identity at a time: a second call while
 * one is outstanding returns that one rather than queuing another archive
 * build. Terminal requests (delivered, expired, failed) do not block a new one.
 */
export async function requestDataExport(
  prisma: PrismaClient,
  input: {
    identityId: string;
    ipAddress?: string | null;
    requestId?: string | null;
    now?: Date;
  },
): Promise<{ view: ExportRequestView; jobRequestId: string | null }> {
  const now = input.now ?? new Date();

  const outstanding = await prisma.dataExportRequest.findFirst({
    where: { identityId: input.identityId, status: { in: ['pending', 'building', 'ready'] } },
    orderBy: { createdAt: 'desc' },
  });
  if (outstanding) {
    return { view: toView(outstanding, now), jobRequestId: null };
  }

  const row = await prisma.dataExportRequest.create({
    data: {
      identityId: input.identityId,
      status: 'pending',
      requestedAt: now,
      requestedByIp: input.ipAddress ?? null,
    },
  });

  await writeAudit(prisma, {
    identityId: input.identityId,
    action: 'account.export.requested',
    resourceType: 'data_export',
    resourceId: row.id,
    ipAddress: input.ipAddress ?? null,
    requestId: input.requestId ?? null,
  });

  return { view: toView(row, now), jobRequestId: row.id };
}

export async function getDataExport(
  prisma: PrismaClient,
  input: { requestId: string; identityId: string; downloadSecret: string; now?: Date },
): Promise<ExportRequestView | null> {
  const now = input.now ?? new Date();
  const row = await prisma.dataExportRequest.findUnique({ where: { id: input.requestId } });
  // Same nothing for "not yours" and "does not exist".
  if (!row || row.identityId !== input.identityId) return null;
  return toView(row, now, input.downloadSecret);
}

export async function listDataExports(
  prisma: PrismaClient,
  identityId: string,
  now: Date = new Date(),
): Promise<ExportRequestView[]> {
  const rows = await prisma.dataExportRequest.findMany({
    where: { identityId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  // No token in a list view — the owner asks for one request at a time.
  return rows.map((row) => toView(row, now));
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Assemble the subject's own data. Read-only; every relation is filtered by the
 * subject's ids so nothing belonging to another party can be swept in.
 */
async function gatherSubjectData(
  prisma: PrismaClient,
  identityId: string,
  generatedAt: Date,
): Promise<unknown> {
  const identity = await prisma.identity.findUniqueOrThrow({
    where: { id: identityId },
    select: {
      id: true,
      email: true,
      phone: true,
      displayName: true,
      locale: true,
      createdAt: true,
      customer: {
        select: { id: true, referralCode: true, marketingOptIn: true, dietaryPreferences: true },
      },
    },
  });

  const customerId = identity.customer?.id ?? null;

  const [addresses, orders, reviews, subscriptions, legalAcceptances, supportCases] =
    await Promise.all([
      customerId
        ? prisma.address.findMany({
            where: { customerId },
            select: {
              label: true,
              line1: true,
              landmark: true,
              instructions: true,
              contactPhone: true,
              latitude: true,
              longitude: true,
              createdAt: true,
            },
          })
        : Promise.resolve([]),
      customerId
        ? prisma.order.findMany({
            where: { customerId },
            select: {
              code: true,
              status: true,
              mode: true,
              total: true,
              itemsSubtotal: true,
              deliveryFee: true,
              serviceFee: true,
              tip: true,
              createdAt: true,
              deliveredAt: true,
              items: {
                select: { nameSnapshot: true, quantity: true, priceSnapshot: true, lineTotal: true },
              },
            },
            orderBy: { createdAt: 'desc' },
          })
        : Promise.resolve([]),
      customerId
        ? prisma.review.findMany({
            where: { customerId },
            select: { subject: true, rating: true, comment: true, createdAt: true },
          })
        : Promise.resolve([]),
      customerId
        ? prisma.subscription.findMany({
            where: { customerId },
            select: {
              plan: true,
              status: true,
              pricePerPeriod: true,
              currentPeriodEnd: true,
              cancelledAt: true,
              createdAt: true,
            },
          })
        : Promise.resolve([]),
      prisma.legalAcceptance.findMany({
        where: { identityId },
        select: {
          createdAt: true,
          document: { select: { slug: true, version: true, title: true } },
        },
      }),
      customerId
        ? prisma.supportCase.findMany({
            where: { customerId },
            select: {
              code: true,
              subject: true,
              category: true,
              status: true,
              createdAt: true,
              resolvedAt: true,
            },
          })
        : Promise.resolve([]),
    ]);

  return {
    manifest: exportManifest(identity.id, generatedAt),
    profile: {
      email: identity.email,
      phone: identity.phone,
      displayName: identity.displayName,
      locale: identity.locale,
      joinedAt: identity.createdAt,
      referralCode: identity.customer?.referralCode ?? null,
      marketingOptIn: identity.customer?.marketingOptIn ?? false,
      dietaryPreferences: identity.customer?.dietaryPreferences ?? null,
    },
    addresses,
    orders,
    reviews,
    subscriptions,
    legal_acceptances: legalAcceptances,
    support_cases: supportCases,
  };
}

export interface BuildResult {
  readonly view: ExportRequestView;
  readonly status: ExportStatus;
  /** True when this call did not own the build — it lost or never held the claim. */
  readonly skipped?: boolean;
}

const BUILD_CLAIM_MS = EXPORT_BUILD_CLAIM_SECONDS * 1000;

/**
 * Build the archive for a pending request.
 *
 * **Atomic claim before any work.** Exactly one worker moves the row from
 * `pending` (or a stale `building`) to `building` under its own `buildClaimId`;
 * a worker that loses that race returns immediately without reading subject
 * data or writing a byte. Every later write — success or failure — is guarded
 * on that same `buildClaimId`, so a worker can only ever transition the state
 * it holds. A blob written before a subsequent database failure is deleted.
 *
 * Never throws for an expected condition: it records the outcome on the row and
 * returns, so one bad export cannot wedge the queue.
 */
export async function buildDataExport(
  prisma: PrismaClient,
  archive: ExportArchivePort,
  input: { requestId: string; ttlHours: number; now?: Date },
): Promise<BuildResult> {
  const now = input.now ?? new Date();
  const claimId = randomUUID();

  const request = await prisma.dataExportRequest.findUnique({ where: { id: input.requestId } });
  if (!request) throw new DataExportError('not_found', 'Export request not found.');

  // Only `pending`, or a `building` row whose claim has gone stale, is buildable.
  const claimStale =
    request.status === 'building' &&
    request.buildClaimUntil !== null &&
    request.buildClaimUntil.getTime() <= now.getTime();
  if (request.status !== 'pending' && !claimStale) {
    return { view: toView(request, now), status: request.status as ExportStatus, skipped: true };
  }

  if ((request.buildAttempts ?? 0) >= EXPORT_BUILD_MAX_ATTEMPTS) {
    const failed = await prisma.dataExportRequest.updateMany({
      where: { id: request.id, status: { in: ['pending', 'building'] } },
      data: {
        status: 'failed',
        failedAt: now,
        failureReason: 'exceeded the maximum number of build attempts',
        buildClaimId: null,
        buildClaimUntil: null,
      },
    });
    if (failed.count > 0) {
      await writeAudit(prisma, {
        identityId: request.identityId,
        action: 'account.export.failed',
        resourceType: 'data_export',
        resourceId: request.id,
      });
    }
    const after = await prisma.dataExportRequest.findUniqueOrThrow({ where: { id: request.id } });
    return { view: toView(after, now), status: after.status as ExportStatus, skipped: true };
  }

  // --- Claim -------------------------------------------------------------
  // A fresh `pending` row is a real state transition; reclaiming a stale
  // `building` claim is not — the row never leaves `building` — so only the
  // former is checked against the state machine.
  if (request.status === 'pending') {
    assertExportTransition('pending', 'building');
  }
  const claimed = await prisma.dataExportRequest.updateMany({
    where: {
      id: request.id,
      OR: [
        { status: 'pending' },
        { status: 'building', buildClaimUntil: { lte: now } },
      ],
    },
    data: {
      status: 'building',
      buildClaimId: claimId,
      buildClaimUntil: new Date(now.getTime() + BUILD_CLAIM_MS),
      buildAttempts: { increment: 1 },
    },
  });
  if (claimed.count === 0) {
    // Another worker holds the claim, or the row moved on. Do nothing.
    const after = await prisma.dataExportRequest.findUniqueOrThrow({ where: { id: request.id } });
    return { view: toView(after, now), status: after.status as ExportStatus, skipped: true };
  }

  // --- Work under the claim -------------------------------------------
  let writtenKey: string | null = null;
  try {
    const document = await gatherSubjectData(prisma, request.identityId, now);
    const body = Buffer.from(JSON.stringify(document, null, 2), 'utf8');

    const key = generateToken(24).replace(/[^A-Za-z0-9_-]/g, '');
    const stored = await archive.write({ key, body, contentType: ARCHIVE_CONTENT_TYPE });
    writtenKey = key;

    assertExportTransition('building', 'ready');
    const promoted = await prisma.dataExportRequest.updateMany({
      where: { id: request.id, status: 'building', buildClaimId: claimId },
      data: {
        status: 'ready',
        readyAt: now,
        expiresAt: exportExpiresAt(now, input.ttlHours),
        storageKey: key,
        sizeBytes: stored.sizeBytes,
        buildClaimId: null,
        buildClaimUntil: null,
      },
    });
    if (promoted.count === 0) {
      // Our claim was stolen (it had gone stale and another worker reclaimed).
      // The winning worker owns the row now; discard the blob we just wrote.
      await archive.delete(key).catch(() => undefined);
      const after = await prisma.dataExportRequest.findUniqueOrThrow({ where: { id: request.id } });
      return { view: toView(after, now), status: after.status as ExportStatus, skipped: true };
    }

    const updated = await prisma.dataExportRequest.findUniqueOrThrow({ where: { id: request.id } });
    await writeAudit(prisma, {
      identityId: request.identityId,
      action: 'account.export.ready',
      resourceType: 'data_export',
      resourceId: request.id,
      after: { sizeBytes: stored.sizeBytes, expiresAt: updated.expiresAt?.toISOString() },
    });

    return { view: toView(updated, now), status: 'ready' };
  } catch (error) {
    // Clean up any blob written before the failure.
    if (writtenKey) await archive.delete(writtenKey).catch(() => undefined);

    // Fail only the state this worker claimed. If the claim was stolen in the
    // meantime, `count` is 0 and the reclaiming worker owns the outcome.
    const failed = await prisma.dataExportRequest.updateMany({
      where: { id: request.id, status: 'building', buildClaimId: claimId },
      data: {
        status: 'failed',
        failedAt: now,
        failureReason: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        storageKey: null,
        buildClaimId: null,
        buildClaimUntil: null,
      },
    });
    const after = await prisma.dataExportRequest.findUniqueOrThrow({ where: { id: request.id } });
    if (failed.count > 0) {
      await writeAudit(prisma, {
        identityId: request.identityId,
        action: 'account.export.failed',
        resourceType: 'data_export',
        resourceId: request.id,
      });
    }
    return {
      view: toView(after, now),
      status: after.status as ExportStatus,
      skipped: failed.count === 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

const DOWNLOAD_LEASE_MS = EXPORT_DOWNLOAD_LEASE_SECONDS * 1000;

/**
 * Consume a download.
 *
 * Two-phase, so a transient storage outage cannot burn the one permitted
 * download:
 *
 *   1. **Lease.** A guarded `updateMany` takes an exclusive, expiring lease on a
 *      `ready`, unused row. Two concurrent requests cannot both take it; a
 *      crashed download's lease expires and another request may take over.
 *   2. **Read, then commit.** The archive is read *before* the row is marked
 *      delivered. A failed read releases the lease — the row stays `ready` and
 *      `downloadCount: 0`, fully retryable. Only a successful read commits
 *      `delivered` / `downloadCount: 1`, and only under the same lease id, so a
 *      request whose lease expired mid-read cannot deliver a second copy.
 *
 * The archive is deleted after a successful commit. A delete failure leaves
 * `storageKey` set and `status: delivered`; the maintenance orphan sweep
 * retries it.
 */
export async function consumeDataExportDownload(
  prisma: PrismaClient,
  archive: ExportArchivePort,
  input: {
    requestId: string;
    identityId: string;
    token: string;
    downloadSecret: string;
    ipAddress?: string | null;
    httpRequestId?: string | null;
    now?: Date;
  },
): Promise<{ body: Buffer; filename: string }> {
  const now = input.now ?? new Date();
  const leaseId = randomUUID();

  const request = await prisma.dataExportRequest.findUnique({ where: { id: input.requestId } });
  if (!request || request.identityId !== input.identityId) {
    throw new DataExportError('not_found', 'Not found.');
  }
  if (request.status === 'delivered' || request.downloadCount > 0) {
    throw new DataExportError('already_downloaded', 'This export has already been downloaded.');
  }
  if (
    request.status !== 'ready' ||
    request.expiresAt === null ||
    request.expiresAt.getTime() <= now.getTime()
  ) {
    if (request.status === 'ready') {
      // Expired on the way in. Delete the archive here rather than leave an
      // orphan the maintenance sweep will never revisit — it only looks for
      // rows still `ready`.
      if (request.storageKey) await archive.delete(request.storageKey).catch(() => undefined);
      await prisma.dataExportRequest.updateMany({
        where: { id: request.id, status: 'ready' },
        data: { status: 'expired', storageKey: null },
      });
    }
    throw new DataExportError('expired', 'This export link is no longer valid.');
  }
  if (!verifyDownloadToken(input.downloadSecret, input.token, request.id, now)) {
    // Same shape as "not found" — a bad token reveals nothing.
    throw new DataExportError('not_found', 'Not found.');
  }

  // --- Phase 1: take the lease ---------------------------------------
  const leased = await prisma.dataExportRequest.updateMany({
    where: {
      id: request.id,
      status: 'ready',
      downloadCount: 0,
      OR: [{ downloadLeaseUntil: null }, { downloadLeaseUntil: { lte: now } }],
    },
    data: { downloadLeaseId: leaseId, downloadLeaseUntil: new Date(now.getTime() + DOWNLOAD_LEASE_MS) },
  });
  if (leased.count === 0) {
    // Another request holds a live lease, or the row was consumed/expired.
    const after = await prisma.dataExportRequest.findUnique({ where: { id: request.id } });
    if (after && (after.status === 'delivered' || after.downloadCount > 0)) {
      throw new DataExportError('already_downloaded', 'This export has already been downloaded.');
    }
    throw new DataExportError('in_progress', 'This export is already being downloaded.');
  }

  const key = request.storageKey;
  if (!key) {
    // Nothing to serve. Release the lease and treat as expired.
    await prisma.dataExportRequest.updateMany({
      where: { id: request.id, downloadLeaseId: leaseId },
      data: { downloadLeaseId: null, downloadLeaseUntil: null },
    });
    throw new DataExportError('expired', 'This export link is no longer valid.');
  }

  // --- Phase 2: read the archive, then commit -----------------------
  let body: Buffer;
  try {
    body = await archive.read(key);
  } catch {
    // Release the lease. The row is untouched — `ready`, unused — so the owner
    // can simply try again once storage recovers.
    await prisma.dataExportRequest.updateMany({
      where: { id: request.id, downloadLeaseId: leaseId },
      data: { downloadLeaseId: null, downloadLeaseUntil: null },
    });
    throw new DataExportError('storage_unavailable', 'The export could not be retrieved. Please try again shortly.');
  }

  assertExportTransition('ready', 'delivered');
  const committed = await prisma.dataExportRequest.updateMany({
    where: { id: request.id, status: 'ready', downloadCount: 0, downloadLeaseId: leaseId },
    data: {
      status: 'delivered',
      deliveredAt: now,
      downloadCount: 1,
      downloadLeaseId: null,
      downloadLeaseUntil: null,
    },
  });
  if (committed.count === 0) {
    // Our lease expired mid-read and another request took over and delivered.
    // We must not hand out a second copy.
    throw new DataExportError('already_downloaded', 'This export has already been downloaded.');
  }

  // Delete the archive. If this fails the row stays `delivered` with
  // `storageKey` set; the maintenance orphan sweep retries the delete.
  const deleted = await archive
    .delete(key)
    .then(() => true)
    .catch(() => false);
  if (deleted) {
    await prisma.dataExportRequest.update({
      where: { id: request.id },
      data: { storageKey: null },
    });
  }

  await writeAudit(prisma, {
    identityId: input.identityId,
    action: 'account.export.downloaded',
    resourceType: 'data_export',
    resourceId: request.id,
    after: { sizeBytes: request.sizeBytes },
    ipAddress: input.ipAddress ?? null,
    requestId: input.httpRequestId ?? null,
  });

  return { body, filename: `dash-app-export-${request.id}.json` };
}

/** Ready archives whose window has passed unread — for the cleanup pass. */
export async function findExpiredExports(
  prisma: PrismaClient,
  now: Date = new Date(),
  limit = 500,
): Promise<{ id: string; storageKey: string | null }[]> {
  return prisma.dataExportRequest.findMany({
    where: { status: 'ready', expiresAt: { lte: now } },
    select: { id: true, storageKey: true },
    take: limit,
  });
}

/** Mark one expired export and delete its archive. Idempotent. */
export async function expireDataExport(
  prisma: PrismaClient,
  archive: ExportArchivePort,
  row: { id: string; storageKey: string | null },
): Promise<void> {
  if (row.storageKey) await archive.delete(row.storageKey).catch(() => undefined);
  await prisma.dataExportRequest.updateMany({
    where: { id: row.id, status: 'ready' },
    data: { status: 'expired', storageKey: null },
  });
}

/** `building` rows whose claim has gone stale — an abandoned build. */
export async function findStaleExportBuilds(
  prisma: PrismaClient,
  now: Date = new Date(),
  limit = 500,
): Promise<{ id: string; identityId: string; storageKey: string | null }[]> {
  return prisma.dataExportRequest.findMany({
    where: { status: 'building', buildClaimUntil: { lte: now } },
    select: { id: true, identityId: true, storageKey: true },
    take: limit,
  });
}

/**
 * Fail one abandoned build and drop any half-written blob. Idempotent, and
 * guarded so it never touches a row a worker has since reclaimed.
 */
export async function failStaleExportBuild(
  prisma: PrismaClient,
  archive: ExportArchivePort,
  row: { id: string; identityId: string; storageKey: string | null },
  now: Date = new Date(),
): Promise<boolean> {
  if (row.storageKey) await archive.delete(row.storageKey).catch(() => undefined);
  const failed = await prisma.dataExportRequest.updateMany({
    where: { id: row.id, status: 'building', buildClaimUntil: { lte: now } },
    data: {
      status: 'failed',
      failedAt: now,
      failureReason: 'the build was abandoned before it completed',
      storageKey: null,
      buildClaimId: null,
      buildClaimUntil: null,
    },
  });
  if (failed.count > 0) {
    await writeAudit(prisma, {
      identityId: row.identityId,
      action: 'account.export.failed',
      resourceType: 'data_export',
      resourceId: row.id,
    });
  }
  return failed.count > 0;
}

/**
 * `delivered` rows that still carry a `storageKey` — a download whose archive
 * delete failed. The bytes are already spent; this just retries the delete.
 */
export async function findOrphanedExportArchives(
  prisma: PrismaClient,
  limit = 500,
): Promise<{ id: string; storageKey: string | null }[]> {
  return prisma.dataExportRequest.findMany({
    where: { status: { in: ['delivered', 'expired'] }, storageKey: { not: null } },
    select: { id: true, storageKey: true },
    take: limit,
  });
}

/** Retry a failed archive delete. Nulls `storageKey` only once the blob is gone. */
export async function cleanOrphanedExportArchive(
  prisma: PrismaClient,
  archive: ExportArchivePort,
  row: { id: string; storageKey: string | null },
): Promise<boolean> {
  if (!row.storageKey) return false;
  const deleted = await archive
    .delete(row.storageKey)
    .then(() => true)
    .catch(() => false);
  if (deleted) {
    await prisma.dataExportRequest.updateMany({
      where: { id: row.id, storageKey: row.storageKey },
      data: { storageKey: null },
    });
  }
  return deleted;
}
