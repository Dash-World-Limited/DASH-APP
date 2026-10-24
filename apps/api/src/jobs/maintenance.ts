/**
 * The scheduler's entry point, and the lease that keeps two of them apart.
 *
 * Every maintenance job in this repository was implemented, tested, and then
 * never run. `HANDOFF.md` has said "nothing schedules them" since Milestone C.
 * A retention policy that never executes is a policy on paper; an export
 * archive that never expires is a download link that works for ever.
 *
 * This module does not *become* a scheduler — it is the thing a scheduler
 * calls. Deliberately:
 *
 *   * **No in-process timer.** A `setInterval` in the API means every instance
 *     runs every job, and the number of times the ledger gets reconciled
 *     becomes a function of how many pods happen to be up.
 *   * **No queue-based self-scheduling.** The queue is Redis, Redis is exactly
 *     what a maintenance run must keep working without, and a job that
 *     schedules its own successor stops for ever the first time one run dies.
 *
 * What it is instead: one idempotent command (`npm run maintenance:all`) that a
 * cron entry, a systemd timer, or a Kubernetes CronJob invokes. Those exist, are
 * operated by people who understand the platform, and restart on their own. The
 * repository does not need to reinvent one, and ADR-0011's reasoning about not
 * choosing a platform applies here too.
 *
 * ## The lease
 *
 * Two instances firing the same cron minute is normal, not exceptional. The
 * jobs are individually safe to run concurrently — retention is idempotent, the
 * export builder takes an atomic claim — but doing the same work twice still
 * costs two full ledger scans and writes two audit rows for one fact.
 *
 * Acquisition has to work identically on SQLite and PostgreSQL, so it uses
 * nothing provider-specific: a guarded `updateMany` takes over a lease whose
 * expiry has passed, and a `create` claims a job that has never run, with the
 * primary key rejecting the loser of that race. No advisory locks.
 *
 * A lease **expires** rather than being released only on success. An instance
 * that is killed mid-run must not block the job until a human notices.
 */

import { randomUUID } from 'node:crypto';
import { redactSecretsInText } from '@dash/domain/redaction';
import type { PrismaClient } from '@dash/db';

/**
 * How long a lease is honoured.
 *
 * Longer than any job should take, short enough that a killed instance does not
 * block the next scheduled run for hours. A job that legitimately runs longer
 * than this will have its lease taken over — which is why the jobs remain
 * individually concurrency-safe rather than relying on the lease for
 * correctness. The lease prevents waste, not corruption.
 */
export const DEFAULT_LEASE_MS = 30 * 60_000;

export interface LeaseResult {
  readonly acquired: boolean;
  readonly holder: string;
  /** Why it was not acquired. Null when it was. */
  readonly heldBy: string | null;
}

/**
 * Take the lease for a job, or report that someone else has it.
 *
 * Never throws for contention — losing a race is an ordinary outcome, not an
 * error, and a scheduler that treated it as one would page someone every time
 * two pods overlapped.
 */
export async function acquireLease(
  prisma: PrismaClient,
  job: string,
  options: { now?: Date; leaseMs?: number; holder?: string } = {},
): Promise<LeaseResult> {
  const now = options.now ?? new Date();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const holder = options.holder ?? randomUUID();
  const expiresAt = new Date(now.getTime() + leaseMs);

  // Take over an expired lease. Guarded on the expiry, so a live lease is not
  // stolen and two winners are impossible.
  const takenOver = await prisma.maintenanceLease.updateMany({
    where: { job, expiresAt: { lte: now } },
    data: { holder, acquiredAt: now, expiresAt },
  });
  if (takenOver.count === 1) return { acquired: true, holder, heldBy: null };

  // No row at all yet. The primary key decides the race between two instances
  // both reaching this line for a job that has never run.
  try {
    await prisma.maintenanceLease.create({
      data: { job, holder, acquiredAt: now, expiresAt },
    });
    return { acquired: true, holder, heldBy: null };
  } catch {
    // Either the row now exists (we lost the create race) or it existed all
    // along and is unexpired. Both mean: someone else is running this job.
    const current = await prisma.maintenanceLease.findUnique({
      where: { job },
      select: { holder: true },
    });
    return { acquired: false, holder, heldBy: current?.holder ?? null };
  }
}

/**
 * Release the lease and record how the run went.
 *
 * Guarded on still being the holder: an instance whose lease expired and was
 * taken over must not stamp its result over the run that replaced it.
 */
export async function releaseLease(
  prisma: PrismaClient,
  job: string,
  holder: string,
  outcome: { succeeded: boolean; now?: Date },
): Promise<{ released: boolean }> {
  const now = outcome.now ?? new Date();

  const released = await prisma.maintenanceLease.updateMany({
    where: { job, holder },
    data: {
      // Expire it immediately so the next scheduled run is not made to wait out
      // the remainder of a lease whose work is already finished.
      expiresAt: now,
      ...(outcome.succeeded ? { lastSucceededAt: now } : { lastFailedAt: now }),
    },
  });

  return { released: released.count === 1 };
}

/**
 * Run a job under its lease.
 *
 * Returns `skipped` when another instance holds it. The lease is released in a
 * `finally`, so a throwing job does not hold it until expiry.
 */
export async function withLease<T>(
  prisma: PrismaClient,
  job: string,
  run: () => Promise<T>,
  options: { now?: Date; leaseMs?: number; holder?: string } = {},
): Promise<{ skipped: true } | { skipped: false; result: T }> {
  const lease = await acquireLease(prisma, job, options);
  if (!lease.acquired) return { skipped: true };

  let succeeded = false;
  try {
    const result = await run();
    succeeded = true;
    return { skipped: false, result };
  } finally {
    await releaseLease(prisma, job, lease.holder, { succeeded, now: options.now });
  }
}

/**
 * Jobs whose last success is older than this are reported stale.
 *
 * Staleness is the alert that matters. A job that fails loudly gets noticed; a
 * job that silently stops being scheduled is the one that goes unnoticed for a
 * quarter, which is precisely how this repository arrived at four implemented
 * jobs that nothing ran.
 */
export const STALENESS_THRESHOLD_MS: Readonly<Record<string, number>> = {
  retention: 36 * 60 * 60_000,
  accounts: 36 * 60 * 60_000,
  ledger: 36 * 60 * 60_000,
  outbox: 30 * 60_000,
};

export interface MaintenanceStaleness {
  readonly job: string;
  readonly lastSucceededAt: Date | null;
  readonly stale: boolean;
}

/**
 * Which jobs have not succeeded recently enough.
 *
 * A job that has never run at all counts as stale — "no record of success" and
 * "succeeded long ago" are the same operational fact, and treating the first as
 * healthy is how a scheduler that was never wired up looks fine.
 */
export async function maintenanceStaleness(
  prisma: PrismaClient,
  options: { now?: Date } = {},
): Promise<readonly MaintenanceStaleness[]> {
  const now = options.now ?? new Date();
  const leases = await prisma.maintenanceLease.findMany({
    select: { job: true, lastSucceededAt: true },
  });
  const byJob = new Map(leases.map((lease) => [lease.job, lease.lastSucceededAt]));

  return Object.entries(STALENESS_THRESHOLD_MS).map(([job, threshold]) => {
    const lastSucceededAt = byJob.get(job) ?? null;
    return {
      job,
      lastSucceededAt,
      stale: lastSucceededAt === null || now.getTime() - lastSucceededAt.getTime() > threshold,
    };
  });
}

/** One job's outcome in a combined run. */
export interface MaintenanceJobOutcome {
  readonly job: string;
  readonly ran: boolean;
  /** True when another instance held the lease. Not a failure. */
  readonly skipped: boolean;
  readonly failed: boolean;
  /** Counts only, and scrubbed. Never row data. */
  readonly summary: string;
}

/**
 * Reduce a job failure to something safe to print and store.
 *
 * A maintenance job touches sessions, locations, export archives, and the
 * ledger. Its errors can carry a connection string from the driver underneath,
 * so they go through the same scrubber the logger uses.
 */
export function describeJobFailure(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactSecretsInText(raw).slice(0, 300);
}
