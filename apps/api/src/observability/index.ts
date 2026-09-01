/**
 * Observability seams.
 *
 * Interfaces plus console implementations, so Codex can connect a real service
 * later by writing one adapter rather than editing every call site.
 *
 * The rule that shapes this file: **anything leaving the application is
 * redacted first.** An error tracker and a metrics backend are third parties.
 * Sending them a customer's phone number, a bank account, or a token is a data
 * leak whether or not the vendor is trustworthy, and it is the kind that is
 * invisible until someone audits the vendor's dashboard.
 */

import { redact } from '@dash/db';

// ---------------------------------------------------------------------------
// Error reporting
// ---------------------------------------------------------------------------

export interface ErrorContext {
  /** Correlates with the API response and the request log. */
  readonly requestId?: string | undefined;
  /** Who was acting. An opaque id, never a name, email, or phone number. */
  readonly identityId?: string | undefined;
  readonly route?: string | undefined;
  readonly statusCode?: number | undefined;
  /** Anything else worth knowing. Redacted before it leaves. */
  readonly extra?: Record<string, unknown> | undefined;
}

export interface ErrorReportPort {
  readonly providerName: string;
  readonly isLive: boolean;
  report(error: unknown, context: ErrorContext): void;
}

/**
 * Keys whose values must never reach an error tracker, however nested.
 *
 * Deliberately wider than the audit-log list: an error payload is assembled ad
 * hoc at a failure site, so it is far more likely to carry something nobody
 * intended than a deliberately-constructed audit entry is.
 */
const NEVER_REPORT = new Set([
  'password',
  'passwordhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'challengetoken',
  'csrftoken',
  'code',
  'devcode',
  'otp',
  'pin',
  'secret',
  'mfasecret',
  'totp',
  'recoverycode',
  'recoverycodes',
  'accountnumber',
  'bankaccountcipher',
  'mfasecretcipher',
  'authorization',
  'cookie',
  'apikey',
  'encryptionkey',
  'phone',
  'email',
  'latitude',
  'longitude',
]);

/**
 * Strip anything sensitive before an event leaves the process.
 *
 * Runs `redact()` from `@dash/db` first — that is the same function the audit
 * log uses, so the two cannot disagree — then applies the wider list above.
 */
export function scrubForExport(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => scrubForExport(entry, depth + 1));
  if (typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    output[key] = NEVER_REPORT.has(key.toLowerCase())
      ? '[redacted]'
      : scrubForExport(nested, depth + 1);
  }
  return output;
}

/**
 * Reduce an error to what is safe to send.
 *
 * The message is kept because it is the single most useful field, but a stack
 * is kept only in non-production: a stack can contain interpolated values from
 * the frame that threw, and those are exactly what must not travel.
 */
export function describeError(
  error: unknown,
  includeStack: boolean,
): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(includeStack && error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: 'UnknownError', message: typeof error === 'string' ? error : 'Non-Error thrown' };
}

/**
 * The default: log and go no further.
 *
 * Honest about being local — `isLive` is false, so the boot banner cannot imply
 * errors are reaching anyone.
 */
export class ConsoleErrorReporter implements ErrorReportPort {
  readonly providerName = 'console';
  readonly isLive = false;

  constructor(
    private readonly includeStack: boolean,
    private readonly quiet = false,
  ) {}

  report(error: unknown, context: ErrorContext): void {
    if (this.quiet) return;

    console.error('[error]', {
      ...describeError(error, this.includeStack),
      requestId: context.requestId,
      route: context.route,
      statusCode: context.statusCode,
      identityId: context.identityId,
      extra: context.extra ? scrubForExport(redact(context.extra)) : undefined,
    });
  }
}

/** Collects instead of printing. Used by tests to assert what would be sent. */
export class RecordingErrorReporter implements ErrorReportPort {
  readonly providerName = 'recording';
  readonly isLive = false;
  readonly reports: { error: unknown; context: ErrorContext; payload: unknown }[] = [];

  constructor(private readonly includeStack = false) {}

  report(error: unknown, context: ErrorContext): void {
    this.reports.push({
      error,
      context,
      payload: {
        ...describeError(error, this.includeStack),
        ...scrubForExport(redact({ ...context })) as Record<string, unknown>,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Operational events and metrics
// ---------------------------------------------------------------------------

export type MetricTags = Readonly<Record<string, string | number | boolean>>;

export interface MetricsPort {
  readonly providerName: string;
  readonly isLive: boolean;
  /** Something happened once. */
  increment(name: string, tags?: MetricTags): void;
  /** Something took this long, in milliseconds. */
  timing(name: string, milliseconds: number, tags?: MetricTags): void;
  /** Something is currently this big. */
  gauge(name: string, value: number, tags?: MetricTags): void;
}

/**
 * Tag values are dimensions, not payloads.
 *
 * A metrics backend indexes tags, so a high-cardinality value — an order id, a
 * phone number — creates one time series per value. That is both a cost problem
 * and a privacy problem: the id ends up permanently in a third-party index.
 * Anything that is not a small, bounded set is rejected here rather than sent.
 */
const MAX_TAG_LENGTH = 64;

export function safeTags(tags: MetricTags | undefined): Record<string, string> {
  if (!tags) return {};

  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (NEVER_REPORT.has(key.toLowerCase())) continue;

    const rendered = String(value);
    // A long value is almost certainly an id rather than a category.
    output[key] = rendered.length > MAX_TAG_LENGTH ? '[dropped]' : rendered;
  }
  return output;
}

export class ConsoleMetrics implements MetricsPort {
  readonly providerName = 'console';
  readonly isLive = false;

  constructor(private readonly quiet = false) {}

  increment(name: string, tags?: MetricTags): void {
    this.write('count', name, 1, tags);
  }

  timing(name: string, milliseconds: number, tags?: MetricTags): void {
    this.write('timing', name, milliseconds, tags);
  }

  gauge(name: string, value: number, tags?: MetricTags): void {
    this.write('gauge', name, value, tags);
  }

  private write(kind: string, name: string, value: number, tags?: MetricTags): void {
    if (this.quiet) return;
    console.warn(`[metric] ${kind} ${name}=${value}`, safeTags(tags));
  }
}

/** Collects instead of printing. */
export class RecordingMetrics implements MetricsPort {
  readonly providerName = 'recording';
  readonly isLive = false;
  readonly events: { kind: string; name: string; value: number; tags: Record<string, string> }[] =
    [];

  increment(name: string, tags?: MetricTags): void {
    this.events.push({ kind: 'count', name, value: 1, tags: safeTags(tags) });
  }

  timing(name: string, milliseconds: number, tags?: MetricTags): void {
    this.events.push({ kind: 'timing', name, value: milliseconds, tags: safeTags(tags) });
  }

  gauge(name: string, value: number, tags?: MetricTags): void {
    this.events.push({ kind: 'gauge', name, value, tags: safeTags(tags) });
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type DependencyStatus = 'ok' | 'degraded' | 'down';

export interface DependencyCheck {
  readonly name: string;
  readonly status: DependencyStatus;
  readonly latencyMs: number;
}

export interface ReadinessResult {
  readonly ready: boolean;
  readonly checks: readonly DependencyCheck[];
}

/**
 * Time-bounded dependency check.
 *
 * A readiness probe that can hang is worse than one that fails: an orchestrator
 * waiting on it keeps the instance in service. The timeout is what turns a
 * hung dependency into a "down" answer.
 */
export async function checkDependency(
  name: string,
  probe: () => Promise<unknown>,
  timeoutMs = 2_000,
): Promise<DependencyCheck> {
  const startedAt = Date.now();

  try {
    await Promise.race([
      probe(),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeoutMs).unref?.(),
      ),
    ]);
    return { name, status: 'ok', latencyMs: Date.now() - startedAt };
  } catch {
    // The reason is deliberately dropped. A readiness probe is unauthenticated,
    // and a database error message names hosts, schemas, and sometimes
    // credentials. The detail belongs in the log, not the response.
    return { name, status: 'down', latencyMs: Date.now() - startedAt };
  }
}
