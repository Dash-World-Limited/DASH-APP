/**
 * Making the logger incapable of printing a secret.
 *
 * Pino's own `redact` option is path-based: you name `req.headers.authorization`
 * and it censors that path. That is fast and exact, and it is the right tool for
 * a field whose location you know in advance. It has one blind spot, and it is
 * the blind spot that actually leaks credentials in practice:
 *
 *   **A path cannot reach inside a string.**
 *
 * When Prisma cannot reach the database it throws
 * `Can't reach database server at postgresql://dash:hunter2@db.internal:5432`.
 * When ioredis gives up it does something similar. That error reaches the log
 * through `err` in the request error handler, and no `redact.paths` entry in
 * existence will censor the password sitting in the middle of that sentence.
 *
 * Paths have a second blind spot, quieter than the first: they only cover the
 * paths somebody thought of. `log.info({ paystackSecretKey })` from a new call
 * site sits at no path Pino was told about, holds a value that is not in the
 * environment and not a known-secret literal, and would be printed in full.
 *
 * So this module layers three things over Pino:
 *
 *   1. **Paths**, generated where they are known — headers, body fields,
 *      `set-cookie`. Cheap and exact.
 *   2. **An `err` serializer** that scrubs the message and stack by shape.
 *   3. **A log-method hook** that redacts secret-shaped *keys* by the shared
 *      vocabulary and scrubs credentials out of *strings*, on both the root
 *      logger and every child, at any path and any nesting depth.
 *
 * The vocabulary and the scrubbing both live in `@dash/domain/redaction`, so
 * the logger, the audit log, and the error-tracker seam cannot disagree about
 * what counts as sensitive.
 */

import {
  isSensitiveKey,
  redactDeep,
  redactSecretsInText,
  REDACTED,
} from '@dash/domain/redaction';
import { presentSecretValues } from './classification.js';

/**
 * Paths Pino censors directly.
 *
 * Two groups. Request/response paths are locations a credential legitimately
 * arrives at — an `Authorization` header is supposed to hold a token, so it is
 * censored rather than treated as a bug. Body paths are fields a client posts.
 *
 * `*` is Pino's single-level wildcard. `req.body.*.password` therefore covers a
 * password one level inside the body without the cost of a deep walk; anything
 * deeper is caught by the hook below instead.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  // --- Request headers -------------------------------------------------------
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["proxy-authorization"]',
  'req.headers["x-api-key"]',
  'req.headers["x-csrf-token"]',
  'req.headers["idempotency-key"]',
  // Provider webhook signatures. Not a credential a caller must protect, but it
  // is a MAC over a body and there is no reason to archive it.
  'req.headers["x-paystack-signature"]',

  // --- Response headers ------------------------------------------------------
  'res.headers["set-cookie"]',

  // --- Request bodies --------------------------------------------------------
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.code',
  'req.body.otp',
  'req.body.token',
  'req.body.accessToken',
  'req.body.refreshToken',
  'req.body.challengeToken',
  'req.body.csrfToken',
  'req.body.secret',
  'req.body.mfaSecret',
  'req.body.totp',
  'req.body.recoveryCode',
  'req.body.recoveryCodes',
  'req.body.pin',
  'req.body.accountNumber',
  'req.body.bankAccountNumber',
  'req.body.*.password',
  'req.body.*.accountNumber',
];

/**
 * Everything the text scrubber should strip literally, captured once at boot.
 *
 * Read from the environment at server construction rather than on every log
 * line: the values do not change while the process runs, and re-reading
 * `process.env` per log write would be both slow and a second place secrets are
 * touched.
 */
export function knownSecretValues(source: Record<string, unknown>): string[] {
  return presentSecretValues(source);
}

/**
 * The shape Pino requires of an `err` serializer. `type`, `message`, and
 * `stack` are all mandatory and all strings, hence the empty-string fallback
 * for an error thrown without a stack.
 */
export interface SerializedError {
  [key: string]: unknown;
  type: string;
  message: string;
  stack: string;
}

/** Pino's `err` serializer, with the message and stack scrubbed by shape. */
export function buildErrorSerializer(
  knownSecrets: readonly string[],
): (error: unknown) => SerializedError {
  return function serializeError(error: unknown): SerializedError {
    const clean = (text: string): string => redactSecretsInText(text, knownSecrets);

    if (!(error instanceof Error)) {
      return { type: 'NonError', message: clean(String(error)), stack: '' };
    }

    const serialized: SerializedError = {
      type: error.name,
      message: clean(error.message),
      stack: error.stack === undefined ? '' : clean(error.stack),
    };

    // Prisma and ioredis both hang useful fields off the error — `code`,
    // `clientVersion`, `meta`. `meta` in particular has carried a connection
    // target, so it goes through the same walk as anything else rather than
    // being copied across verbatim.
    const fields = error as unknown as Record<string, unknown>;

    for (const key of ['code', 'clientVersion', 'errno', 'syscall'] as const) {
      const value = fields[key];
      if (value !== undefined) serialized[key] = value;
    }

    if (fields['meta'] !== undefined) {
      serialized['meta'] = redactDeep(fields['meta'], { knownSecrets, maxDepth: 4 });
    }

    // A cause chain is a full error of its own and is where the underlying
    // connection failure usually lives.
    if (fields['cause'] !== undefined) {
      serialized['cause'] = serializeError(fields['cause']);
    }

    return serialized;
  };
}

/**
 * Keys a real serializer owns — **at the top level of a log call, and nowhere
 * else.**
 *
 * `req` and `res` are consumed by Pino's standard serializers, which expect the
 * real `IncomingMessage` / `ServerResponse`; `LOG_REDACT_PATHS` censors the
 * fields inside them. `err` goes to `buildErrorSerializer`, which understands
 * the non-enumerable message and the `cause` chain. Copying any of those into a
 * plain object would silently disable the thing that protects it.
 *
 * Two corrections are baked into this set, and both were leaks:
 *
 *   1. **Depth.** This used to be honoured at every nesting level, so an
 *      ordinary object like `{ wrapper: { req: { apiKey } } }` skipped the
 *      recursive scrub entirely. Nothing serializes a nested `req`; it is just
 *      a field with a common name. The bypass now applies only at depth 0.
 *   2. **`error` is not on the list.** The server installs exactly one
 *      serializer — `serializers: { err: ... }` in `server.ts`. There is no
 *      `error` serializer, so treating a plain `error` field as owned handed it
 *      no protection at all while exempting it from the only protection it had.
 */
const ROOT_SERIALIZER_KEYS = new Set(['req', 'res', 'err']);

/**
 * How deep the walk goes before it stops inspecting.
 *
 * Reaching it redacts the subtree rather than emitting it. The cap exists to
 * bound work on the hot path, not to define where secrets stop mattering.
 */
const MAX_WALK_DEPTH = 6;

/**
 * Is this a plain object — a `{}` literal or a null-prototype bag?
 *
 * Only those are safe to rebuild. Anything class-based (a Prisma error, a
 * stream, a Buffer, a Date) loses behaviour the moment it is copied key by key,
 * so it is passed through untouched.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * The log-method hook.
 *
 * Runs on the root logger and, because Pino copies hooks to children, on every
 * request logger too. It does two things:
 *
 *   1. **Redacts by key name**, using the same `isSensitiveKey` vocabulary as
 *      the audit log and the error-tracker seam. This is the layer that catches
 *      `log.info({ paystackSecretKey })` — a value that is not in the
 *      environment, is not a known-secret literal, and sits at no path Pino was
 *      told about. Without it, the only protection for an ad-hoc structured
 *      field was that somebody remembered to add its exact path to
 *      `LOG_REDACT_PATHS`, which nobody does at the call site that leaks.
 *   2. **Scrubs strings**, which is where an interpolated connection string
 *      ends up and where no key name can reach.
 *
 * Bounded depth, plain objects only, and the serializer-owned keys skipped —
 * so this stays cheap on a request logger that runs on every response and
 * cannot break the serializers that do the rest of the work.
 */
export function buildLogMethodHook(knownSecrets: readonly string[]) {
  const scrubString = (value: string): string => redactSecretsInText(value, knownSecrets);

  const scrubValue = (value: unknown, depth: number): unknown => {
    if (value === null || value === undefined) return value;

    // Primitives are scrubbed *before* the depth cap is consulted. The cap used
    // to be the first test and returned the value untouched, which meant a
    // credentialed URL or a secret-shaped field deeper than the limit was
    // printed raw — the cap failed open, in the one direction it must not.
    if (typeof value === 'string') return scrubString(value);
    if (typeof value !== 'object') return value;

    // An object past the cap is redacted wholesale rather than emitted
    // uninspected. Losing a deeply nested diagnostic is cheap; printing a
    // credential because it was nested is not.
    if (depth > MAX_WALK_DEPTH) return REDACTED;

    if (Array.isArray(value)) return value.map((entry) => scrubValue(entry, depth + 1));

    // Errors, Buffers, Dates, Prisma errors, streams — anything with behaviour.
    // Rebuilding them would strip it.
    if (!isPlainObject(value)) return value;

    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      // Only at the top level, and only for keys a serializer genuinely owns.
      if (depth === 0 && ROOT_SERIALIZER_KEYS.has(key)) {
        output[key] = nested;
        continue;
      }
      // Credentials only, not personal data: an audit entry naming which phone
      // number an operator changed is the point of an audit entry, and the
      // request log follows the same rule. The error-tracker seam, which sends
      // to a third party, opts into the wider list instead.
      output[key] = isSensitiveKey(key) ? REDACTED : scrubValue(nested, depth + 1);
    }
    return output;
  };

  return function logMethod(
    this: unknown,
    args: unknown[],
    method: (...parameters: unknown[]) => void,
  ): void {
    const scrubbed = args.map((argument) => {
      if (typeof argument === 'string') return scrubString(argument);
      return scrubValue(argument, 0);
    });

    method.apply(this, scrubbed);
  };
}

export { REDACTED };
