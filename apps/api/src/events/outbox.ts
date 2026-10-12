/**
 * The transactional outbox.
 *
 * ## The bug this exists to remove
 *
 * Before this, every background job was scheduled by a dual write:
 *
 * ```ts
 * await prisma.order.update({ ... });          // committed
 * await queue.enqueue({ name: 'dispatch...' }); // separate network call
 * ```
 *
 * Those two steps cannot both succeed or both fail. The gap between them is
 * where work disappears, and it is not hypothetical: `redis/client.ts`
 * classifies an enqueue failure as `retryable` and documents that the caller's
 * durable row is already committed. So a vendor accepts an order, the row
 * commits, Redis is briefly unreachable, `enqueue` throws — and the order sits
 * accepted for ever with no rider dispatched and nothing aware of it. The
 * failure mode is silence.
 *
 * The outbox closes the gap by making the *intent* part of the same
 * transaction as the state change that caused it:
 *
 * ```ts
 * await prisma.$transaction(async (tx) => {
 *   await tx.order.update({ ... });
 *   await enqueueViaOutbox(tx, { name: 'dispatch.find_rider', ... });
 * });
 * ```
 *
 * If the transaction rolls back, the intent rolls back with it. If it commits,
 * the intent is durable and a relay will publish it eventually, however long
 * the queue is down.
 *
 * ## Delivery is at-least-once, and that is deliberate
 *
 * The relay can publish a row and crash before marking it published, so the
 * next pass publishes it again. Exactly-once delivery across two systems is not
 * available at any price; what is available is a duplicate that does nothing,
 * which is why `idempotencyKey` is passed straight through to the queue and why
 * `assertPublishable` refuses an event without one. A duplicate dispatch job
 * for the same order must be a no-op, and the queue adapters already guarantee
 * that.
 *
 * ## What a payload may contain
 *
 * **Identifiers only.** This table is read by operators, survives in database
 * backups, and is not encrypted — unlike `Identity.mfaSecretCipher` or
 * `Vendor.bankAccountCipher`, which are. A payload carrying a phone number
 * would put personal data somewhere Milestone III deliberately keeps it out of,
 * so `assertPublishable` refuses one rather than trusting every future call
 * site to remember.
 */

import { randomUUID } from 'node:crypto';
import { isSensitiveKey, redactSecretsInText } from '@dash/domain/redaction';
import type { QueuePort } from '@dash/domain/ports';
import type { DbClient, PrismaClient } from '@dash/db';

/** How long a relay's claim on a row is honoured before it may be taken over. */
const CLAIM_TTL_MS = 60_000;

/** Rows a single relay pass will publish. Bounded so a backlog is drained in passes. */
const DEFAULT_BATCH_SIZE = 100;

/**
 * Backoff before a failed publish is retried, by attempt number.
 *
 * Capped rather than unbounded: the queue being down for an hour should not
 * push the next attempt a day out, because the whole point is that the work
 * resumes promptly once Redis returns.
 */
export function retryDelayMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts) * 1_000, 5 * 60_000);
}

export class OutboxError extends Error {
  constructor(
    readonly reason: 'missing_idempotency_key' | 'payload_not_serialisable' | 'payload_personal',
    message: string,
  ) {
    super(message);
    this.name = 'OutboxError';
  }
}

export interface OutboxEventInput {
  readonly name: string;
  readonly payload: Record<string, unknown>;
  /**
   * Required, not optional. Publication is at-least-once, so an event without a
   * dedupe key is an event that can run twice — see the module note.
   */
  readonly idempotencyKey: string;
  readonly delayMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
}

/**
 * Refuse a payload that must not be written.
 *
 * Exported so the rule is testable on its own, and so a future call site can
 * check before building a transaction rather than discovering it inside one.
 */
export function assertPublishable(input: OutboxEventInput): void {
  if (!input.idempotencyKey || input.idempotencyKey.trim() === '') {
    throw new OutboxError(
      'missing_idempotency_key',
      `Outbox event "${input.name}" needs an idempotency key — publication is at-least-once, so a duplicate must be harmless`,
    );
  }

  // Personal data must not land in a table that is unencrypted, widely read,
  // and kept in backups. The same vocabulary the logger and audit log use
  // decides, so "what counts as sensitive" has one definition.
  for (const key of Object.keys(input.payload)) {
    if (isSensitiveKey(key, true)) {
      throw new OutboxError(
        'payload_personal',
        `Outbox payload for "${input.name}" carries "${key}", which is personal or secret — outbox payloads are identifiers only`,
      );
    }
  }

  let serialised: string;
  try {
    serialised = JSON.stringify(input.payload);
  } catch {
    throw new OutboxError(
      'payload_not_serialisable',
      `Outbox payload for "${input.name}" is not JSON-serialisable`,
    );
  }
  if (serialised === undefined) {
    throw new OutboxError(
      'payload_not_serialisable',
      `Outbox payload for "${input.name}" is not JSON-serialisable`,
    );
  }
}

/**
 * Record the intent to enqueue, inside the caller's transaction.
 *
 * Takes a `DbClient` rather than a `PrismaClient` precisely so it can be handed
 * a `$transaction` handle — that is the whole point, and the type makes calling
 * it outside one a deliberate act rather than an accident.
 *
 * **Performs no network I/O.** A transaction that waits on Redis holds database
 * locks while a third party is unreachable, which is how a queue outage becomes
 * a database outage.
 */
export async function enqueueViaOutbox(
  db: DbClient,
  input: OutboxEventInput,
): Promise<{ eventId: string }> {
  assertPublishable(input);

  const row = await db.outboxEvent.create({
    data: {
      name: input.name,
      payload: JSON.stringify(input.payload),
      idempotencyKey: input.idempotencyKey,
      delayMs: input.delayMs ?? 0,
      ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
    },
    select: { id: true },
  });

  return { eventId: row.id };
}

export interface RelayResult {
  readonly claimed: number;
  readonly published: number;
  /** Publish attempts that failed and will be retried. */
  readonly retrying: number;
  /** Rows that exhausted `maxAttempts` and are now `failed`. Needs a human. */
  readonly exhausted: number;
  /** Rows that could not be parsed at all. Failed immediately; never retried. */
  readonly undeliverable: number;
}

const EMPTY_RELAY: RelayResult = {
  claimed: 0,
  published: 0,
  retrying: 0,
  exhausted: 0,
  undeliverable: 0,
};

export interface RelayOptions {
  readonly batchSize?: number;
  readonly now?: Date;
  readonly claimTtlMs?: number;
}

/**
 * Publish pending events to the queue.
 *
 * Claim, publish, mark — in that order, and never in one transaction with the
 * network call. The claim is an `updateMany` guarded on the row still being
 * unclaimed, exactly like the export build claim: two relays racing produce one
 * winner and one no-op rather than two publishes.
 *
 * A crash between publish and mark leaves the row claimed; once `claimUntil`
 * passes another relay takes it over and publishes again. That duplicate is the
 * at-least-once guarantee doing its job, and the queue's idempotency key
 * absorbs it.
 */
export async function relayOutbox(
  prisma: PrismaClient,
  queue: QueuePort,
  options: RelayOptions = {},
): Promise<RelayResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const claimTtlMs = options.claimTtlMs ?? CLAIM_TTL_MS;
  const claimId = randomUUID();
  const claimUntil = new Date(now.getTime() + claimTtlMs);

  const candidates = await prisma.outboxEvent.findMany({
    where: {
      status: 'pending',
      availableAt: { lte: now },
      // Unclaimed, or a claim that has expired because its relay died.
      OR: [{ claimId: null }, { claimUntil: { lt: now } }],
    },
    select: { id: true, claimId: true },
    orderBy: { availableAt: 'asc' },
    take: batchSize,
  });

  if (candidates.length === 0) return EMPTY_RELAY;

  let claimed = 0;
  let published = 0;
  let retrying = 0;
  let exhausted = 0;
  let undeliverable = 0;

  for (const candidate of candidates) {
    // Guarded on the claim we *saw*, so a relay that took this row between the
    // read above and here keeps it and we do nothing.
    const won = await prisma.outboxEvent.updateMany({
      where: { id: candidate.id, status: 'pending', claimId: candidate.claimId },
      data: { claimId, claimUntil },
    });
    if (won.count === 0) continue;
    claimed += 1;

    const row = await prisma.outboxEvent.findUnique({
      where: { id: candidate.id },
      select: {
        id: true,
        name: true,
        payload: true,
        idempotencyKey: true,
        delayMs: true,
        attempts: true,
        maxAttempts: true,
      },
    });
    if (!row) continue;

    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      // Unparseable. Retrying cannot help, so it fails immediately rather than
      // consuming eight attempts to reach the same place. The reason names the
      // row, never its contents.
      await prisma.outboxEvent.update({
        where: { id: row.id },
        data: {
          status: 'failed',
          failedAt: now,
          lastError: 'payload is not valid JSON',
          claimId: null,
          claimUntil: null,
        },
      });
      undeliverable += 1;
      continue;
    }

    try {
      await queue.enqueue({
        name: row.name,
        payload,
        delayMs: row.delayMs === 0 ? undefined : row.delayMs,
        idempotencyKey: row.idempotencyKey ?? undefined,
      });

      await prisma.outboxEvent.update({
        where: { id: row.id },
        data: {
          status: 'published',
          publishedAt: now,
          attempts: row.attempts + 1,
          claimId: null,
          claimUntil: null,
          lastError: null,
        },
      });
      published += 1;
    } catch (error) {
      const attempts = row.attempts + 1;
      const spent = attempts >= row.maxAttempts;

      // The message can name a host and, from ioredis, a connection URL. It is
      // scrubbed by `describeRelayFailure` before it is stored, because this
      // column is read by operators and kept in backups.
      await prisma.outboxEvent.update({
        where: { id: row.id },
        data: {
          attempts,
          lastError: describeRelayFailure(error),
          claimId: null,
          claimUntil: null,
          ...(spent
            ? { status: 'failed', failedAt: now }
            : { availableAt: new Date(now.getTime() + retryDelayMs(attempts)) }),
        },
      });

      if (spent) exhausted += 1;
      else retrying += 1;
    }
  }

  return { claimed, published, retrying, exhausted, undeliverable };
}

/**
 * Reduce a publish failure to something safe to store.
 *
 * Bounded and scrubbed. `redactSecretsInText` strips credentials embedded in a
 * URI, which is exactly what an ioredis connection error carries.
 */
export function describeRelayFailure(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactSecretsInText(raw).slice(0, 500);
}

/**
 * Publish immediately after a commit, best effort.
 *
 * The outbox makes delivery *certain*; it does not by itself make delivery
 * *prompt*. Waiting for the next scheduled relay would add minutes to every
 * dispatch, which is a worse product than the dual write it replaced.
 *
 * So the standard pattern: the writer commits the row, then tries to publish it
 * straight away. If that works, latency is what it always was. If it fails —
 * Redis down, network gone — **nothing is raised**, because the row is durable
 * and the scheduled relay will publish it. Rethrowing here would hand the
 * caller a failed request for work that is, in fact, safely recorded.
 *
 * Deliberately awaited rather than fired and forgotten: a floating promise
 * would make the moment of publication unobservable, and every test of "does
 * this endpoint schedule a job" would be a race.
 *
 * Bounded to a small batch. This runs on the request path, and draining a large
 * backlog is the scheduled relay's job, not this one's.
 */
export async function flushOutbox(
  prisma: PrismaClient,
  queue: QueuePort,
  options: { batchSize?: number } = {},
): Promise<RelayResult> {
  try {
    return await relayOutbox(prisma, queue, { batchSize: options.batchSize ?? 25 });
  } catch {
    // Swallowed on purpose — see above. The scheduled relay is the guarantee.
    return EMPTY_RELAY;
  }
}

/**
 * Events that are stuck: `failed`, or pending far longer than they should be.
 *
 * A backlog that is growing is the signal that the queue is down and the outbox
 * is doing its job; a backlog that is growing *and* old is the signal that the
 * relay itself is not running. Both are worth alerting on, so both are counted.
 */
export async function outboxHealth(
  prisma: PrismaClient,
  options: { now?: Date; staleAfterMs?: number } = {},
): Promise<{
  readonly pending: number;
  readonly stalePending: number;
  readonly failed: number;
  readonly healthy: boolean;
}> {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? 15 * 60_000;
  const staleBefore = new Date(now.getTime() - staleAfterMs);

  const [pending, stalePending, failed] = await Promise.all([
    prisma.outboxEvent.count({ where: { status: 'pending' } }),
    prisma.outboxEvent.count({ where: { status: 'pending', createdAt: { lt: staleBefore } } }),
    prisma.outboxEvent.count({ where: { status: 'failed' } }),
  ]);

  return { pending, stalePending, failed, healthy: stalePending === 0 && failed === 0 };
}
