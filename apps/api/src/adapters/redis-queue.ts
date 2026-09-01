/**
 * The production `QueuePort`: BullMQ over Redis.
 *
 * Same interface as `MemoryQueueAdapter`, so nothing that enqueues work knows
 * which one it is talking to. The differences that matter:
 *
 *   - Jobs survive a restart, which is the whole reason `config.ts` refuses
 *     `QUEUE_PROVIDER=memory` in production.
 *   - Work is shared across instances, so two API processes no longer each run
 *     their own dispatch worker and double-offer the same order.
 *
 * **Failure mode: retryable.** An enqueue that cannot reach Redis throws. It
 * does not swallow the error and return a fake job id — a caller that believes
 * work was queued when it was not is how an export sits `pending` forever. The
 * durable row is already committed in PostgreSQL either way, so the failure is
 * recoverable; what would not be recoverable is not knowing it happened.
 *
 * **Idempotency is BullMQ's, not ours.** `idempotencyKey` becomes the BullMQ
 * job id, and BullMQ refuses a second job with an id it already holds. That is
 * the same contract `MemoryQueueAdapter` implements with its `seenKeys` set.
 */

import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { QueueJob, QueuePort } from '@dash/domain/ports';

/** Matches MemoryQueueAdapter's default so switching providers changes nothing. */
const DEFAULT_MAX_ATTEMPTS = 3;

export interface RedisQueueLogger {
  error: (payload: unknown, message: string) => void;
  info: (payload: unknown, message: string) => void;
}

export class RedisQueueAdapter implements QueuePort {
  readonly providerName = 'redis';

  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];
  private closed = false;

  constructor(
    private readonly connection: Redis,
    private readonly log?: RedisQueueLogger,
    /**
     * Namespaces every key. Two deployments sharing one Redis — staging and
     * production on the same managed instance, say — must not consume each
     * other's jobs.
     */
    private readonly prefix = 'dash',
  ) {}

  private queueFor(name: string): Queue {
    const existing = this.queues.get(name);
    if (existing) return existing;

    const queue = new Queue(name, { connection: this.connection, prefix: this.prefix });
    this.queues.set(name, queue);
    return queue;
  }

  async enqueue<T>(input: {
    name: string;
    payload: T;
    delayMs?: number | undefined;
    idempotencyKey?: string | undefined;
    maxAttempts?: number | undefined;
  }): Promise<{ jobId: string }> {
    if (this.closed) throw new Error('Queue is closed');

    const job = await this.queueFor(input.name).add(
      input.name,
      input.payload,
      {
        ...(input.idempotencyKey ? { jobId: input.idempotencyKey } : {}),
        ...(input.delayMs ? { delay: input.delayMs } : {}),
        attempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        // Exponential backoff, matching the memory adapter's shape.
        backoff: { type: 'exponential', delay: 500 },
        // Keep a bounded tail for debugging; BullMQ otherwise grows forever.
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 5_000 },
      },
    );

    // BullMQ returns the existing job when the id is already present, which is
    // the deduplication we want — the caller cannot tell, and should not care.
    return { jobId: job.id ?? input.idempotencyKey ?? input.name };
  }

  process<T>(name: string, handler: (job: QueueJob<T>) => Promise<void>): void {
    const worker = new Worker(
      name,
      async (job: Job) => {
        await handler({
          id: job.id ?? '',
          name: job.name,
          payload: job.data as T,
          attempt: job.attemptsMade + 1,
        });
      },
      { connection: this.connection, prefix: this.prefix },
    );

    // A worker that dies silently is a queue that stops draining with no
    // signal. These are the only two events that mean "nobody is working".
    worker.on('failed', (job, error) => {
      this.log?.error(
        { queue: name, jobId: job?.id, attempt: job?.attemptsMade, error: error.message },
        'queue job failed',
      );
    });
    worker.on('error', (error) => {
      this.log?.error({ queue: name, error: error.message }, 'queue worker error');
    });

    this.workers.push(worker);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
    this.workers.length = 0;
  }
}
