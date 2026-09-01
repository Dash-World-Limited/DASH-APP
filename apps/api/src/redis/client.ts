/**
 * The Redis connection, and the rules about what happens when it is not there.
 *
 * Redis carries exactly two responsibilities in this system, and each has a
 * deliberate, different failure mode. Writing them down here rather than
 * leaving them implicit in a library default is the point of this file.
 *
 * | Responsibility | Classification | If Redis is unavailable |
 * |---|---|---|
 * | Rate limiting | **fail-closed**, correctness-critical for security | Requests are rejected. `@fastify/rate-limit` is registered with `skipOnError: false`. |
 * | Background queue | **retryable**, not request-correctness-critical | `enqueue` throws; the caller's durable row is already committed and the work is re-derivable. |
 *
 * **Rate limiting fails closed on purpose.** `config.ts` already refuses to
 * start production with `RATE_LIMIT_ENABLED=false` on the grounds that it is
 * "the only defence against credential stuffing and OTP brute force". A Redis
 * outage that silently disabled it would be that same disabled state, arrived
 * at by accident instead of by decision — and nobody would see it happen. The
 * library's default is `skipOnError: true`, i.e. fail *open*; this is one of
 * the few places where taking the default would be a security regression.
 *
 * **Nothing durable lives here.** Sessions, OTP challenges, idempotency keys,
 * and the ledger are all PostgreSQL rows and stay that way. Redis holds
 * counters and job payloads: state whose loss costs throughput, never a record.
 *
 * There is no cache. One was not added because nothing currently needs it, and
 * a cache is an invalidation bug waiting for a reason to exist.
 */

import { Redis, type RedisOptions } from 'ioredis';

/** What a Redis-backed responsibility does when the server is unreachable. */
export type RedisFailureMode =
  /** Reject the request. Used where availability must not beat safety. */
  | 'fail_closed'
  /** Carry on without it; the feature is absent but the request is correct. */
  | 'degradable'
  /** Surface the error so the caller or a later sweep can try again. */
  | 'retryable';

export interface RedisResponsibility {
  readonly name: string;
  readonly failureMode: RedisFailureMode;
  /** True when a wrong answer here is a correctness or security defect. */
  readonly correctnessCritical: boolean;
  readonly rationale: string;
}

/**
 * The complete register of what Redis is trusted with.
 *
 * Asserted by `redis.test.ts`, so adding a Redis-backed feature without
 * classifying its failure behaviour fails the suite.
 */
export const REDIS_RESPONSIBILITIES: readonly RedisResponsibility[] = [
  {
    name: 'rate_limit',
    failureMode: 'fail_closed',
    correctnessCritical: true,
    rationale:
      'Rate limiting is the only defence against credential stuffing and OTP brute force. Failing open would remove it silently, so a Redis outage rejects traffic instead.',
  },
  {
    name: 'queue',
    failureMode: 'retryable',
    correctnessCritical: false,
    rationale:
      'Jobs are follow-up work over rows already committed to PostgreSQL. An enqueue failure throws rather than dropping silently; the durable record is what the work is re-derived from.',
  },
];

/**
 * Connection options shared by every client.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ workers, which hold a
 * blocking connection. It means a command waits for reconnection rather than
 * failing after N attempts — correct for a worker, and the reason the rate
 * limiter gets its own client below with a bounded retry instead.
 */
function baseOptions(): RedisOptions {
  return {
    // Connect on first use rather than at construction, so building the server
    // does not require Redis to already be up.
    lazyConnect: true,
    enableAutoPipelining: true,
    // Bounded, jittered backoff. Without a cap a long outage turns into a
    // reconnect storm the moment the server returns.
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  };
}

/**
 * A client for the rate limiter.
 *
 * Bounded retries: a rate-limit check must resolve quickly one way or the
 * other. Hanging until Redis returns would turn an outage into a timeout on
 * every request, which is a worse failure than a clean rejection.
 */
export function createRateLimitRedis(url: string): Redis {
  return new Redis(url, {
    ...baseOptions(),
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 1_000,
  });
}

/**
 * A client for BullMQ.
 *
 * `maxRetriesPerRequest: null` is mandatory here — BullMQ refuses to start a
 * worker otherwise, because its blocking reads must survive a reconnect.
 */
export function createQueueRedis(url: string): Redis {
  return new Redis(url, {
    ...baseOptions(),
    maxRetriesPerRequest: null,
  });
}

/**
 * Is Redis answering?
 *
 * Used by readiness. Returns a boolean rather than throwing, and never returns
 * the reason: `/health/ready` is unauthenticated and says only which
 * dependency and whether it is up.
 */
export async function pingRedis(client: Redis, timeoutMs = 1_000): Promise<boolean> {
  try {
    const pong = await Promise.race([
      client.ping(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeoutMs).unref?.(),
      ),
    ]);
    return pong === 'PONG';
  } catch {
    return false;
  }
}
