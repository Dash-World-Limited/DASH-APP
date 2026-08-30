/**
 * @dash/db — database access.
 *
 * Exports a single shared Prisma client plus the small set of helpers that
 * enforce persistence-level invariants (ledger posting, idempotency, audit).
 *
 * Business rules do NOT live here. This package moves rows; `@dash/domain`
 * decides what the rows should say.
 */

import { PrismaClient } from '@prisma/client';
import {
  assertBalanced,
  type LedgerTransactionDraft,
} from '@dash/domain/ledger';

export * from '@prisma/client';

declare global {
  var __dashPrisma: PrismaClient | undefined;
}

function createClient(): PrismaClient {
  return new PrismaClient({
    log:
      process.env['NODE_ENV'] === 'development'
        ? [{ emit: 'event', level: 'query' }, 'warn', 'error']
        : ['warn', 'error'],
  });
}

/**
 * Shared client.
 *
 * Cached on `globalThis` so Next.js hot reloads and repeated test imports do
 * not open a new connection pool each time — with SQLite that manifests as
 * lock contention rather than an obvious error, so it is worth guarding.
 */
export const prisma: PrismaClient = globalThis.__dashPrisma ?? createClient();

if (process.env['NODE_ENV'] !== 'production') {
  globalThis.__dashPrisma = prisma;
}

export type Prisma = typeof prisma;

/** Anything that can run a query — the client, or a transaction handle. */
export type DbClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export class LedgerPostingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerPostingError';
  }
}

/**
 * Post a ledger transaction.
 *
 * This is the ONLY way money is written. It re-asserts the zero-sum invariant
 * immediately before the insert — `@dash/domain` already checked it when the
 * draft was built, but the check is cheap and this is the last line of defence
 * before the numbers become permanent.
 *
 * Idempotent on `idempotencyKey`: replaying the same key returns the existing
 * transaction rather than posting a second one. That is what makes a retried
 * webhook or a double-tapped "approve payout" safe.
 */
export async function postLedgerTransaction(
  db: DbClient,
  draft: LedgerTransactionDraft,
): Promise<{ id: string; replayed: boolean }> {
  assertBalanced(draft);

  const existing = await db.ledgerTransaction.findUnique({
    where: { idempotencyKey: draft.idempotencyKey },
    select: { id: true },
  });
  if (existing) return { id: existing.id, replayed: true };

  try {
    const created = await db.ledgerTransaction.create({
      data: {
        kind: draft.kind,
        idempotencyKey: draft.idempotencyKey,
        referenceType: draft.referenceType,
        referenceId: draft.referenceId,
        actorId: draft.actorId,
        note: draft.note ?? null,
        occurredAt: draft.occurredAt,
        entries: {
          create: draft.entries.map((entry) => ({
            accountKind: entry.accountKind,
            ownerId: entry.ownerId ?? null,
            amount: entry.amount,
            memo: entry.memo,
          })),
        },
      },
      select: { id: true },
    });
    return { id: created.id, replayed: false };
  } catch (error) {
    // A unique-constraint violation here means two requests raced on the same
    // idempotency key. The other one won; return its result rather than failing
    // the caller, which is the whole point of the key.
    const raced = await db.ledgerTransaction.findUnique({
      where: { idempotencyKey: draft.idempotencyKey },
      select: { id: true },
    });
    if (raced) return { id: raced.id, replayed: true };
    throw error;
  }
}

/**
 * Current balance of an account, derived by summing entries. There is no
 * balance column to read (ADR-0006).
 */
export async function readBalance(
  db: DbClient,
  accountKind: string,
  ownerId?: string | null,
): Promise<number> {
  const result = await db.ledgerEntry.aggregate({
    where: { accountKind, ownerId: ownerId ?? null },
    _sum: { amount: true },
  });
  const raw = result._sum.amount ?? 0;

  // Apply the account's sign convention so liabilities read positive.
  const debitPositive = accountKind === 'platform_cash' || accountKind === 'rider_cash_float';
  const isExpense =
    accountKind === 'promotion_expense' ||
    accountKind === 'refund_expense' ||
    accountKind === 'processing_expense';

  return debitPositive || isExpense ? raw : -raw;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditInput {
  identityId?: string | null;
  onBehalfOf?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/** Keys whose values must never reach the audit log, however they are nested. */
const REDACTED_KEYS = new Set([
  'password',
  'passwordhash',
  'token',
  'refreshtoken',
  'accesstoken',
  'secret',
  'mfasecret',
  'codehash',
  'pin',
  'deliverypinhash',
  'pickupcodehash',
  'bankaccountcipher',
  'bankaccountnumber',
  'cardnumber',
  'cvv',
  'authorization',
  'apikey',
]);

/**
 * Strip secrets before anything is written to the audit trail.
 *
 * The audit log is read by support agents and exported for compliance, so it is
 * one of the widest-read tables in the system. A token that lands here is a
 * token that has leaked, so redaction happens at the write, not at the read.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  if (typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    output[key] = REDACTED_KEYS.has(key.toLowerCase())
      ? '[redacted]'
      : redact(nested, depth + 1);
  }
  return output;
}

export async function writeAudit(db: DbClient, input: AuditInput): Promise<void> {
  await db.auditLog.create({
    data: {
      identityId: input.identityId ?? null,
      onBehalfOf: input.onBehalfOf ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      before: input.before === undefined ? null : JSON.stringify(redact(input.before)),
      after: input.after === undefined ? null : JSON.stringify(redact(input.after)),
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// JSON column helpers
//
// SQLite has no JSON type, so these columns are TEXT. Parsing is centralised so
// a malformed value fails in one place with a clear message rather than
// producing `undefined` somewhere far away.
// ---------------------------------------------------------------------------

export function parseJsonColumn<T>(value: string | null, fallback: T): T {
  if (value === null || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function stringifyJsonColumn(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}
