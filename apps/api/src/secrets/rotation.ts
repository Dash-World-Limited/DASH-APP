/**
 * Key rotation: finding rows written under an old key, and moving them.
 *
 * The envelope design already makes rotation possible without a migration —
 * every ciphertext names the key that wrote it, so a new key can become active
 * while old rows keep decrypting under a retired one. What the design did not
 * have was the operational half: a way to answer **"is it safe to destroy the
 * old key yet?"**
 *
 * That question is the dangerous one. Removing a retired key while rows still
 * name it does not fail loudly at deploy; it fails at the next read of those
 * particular rows, as `unknown_key`, and there is no recovery except restoring
 * the key. If the key has been destroyed per the retention policy, the data is
 * gone. So the retirement step needs a countable, checkable answer, and this
 * module is it.
 *
 * ## Three properties this has to get right
 *
 * **Forward progress**, which is entirely the walker's job. A pass reads rows
 * ordered by id, one bounded page at a time, and steps its cursor past every
 * row it examines — moved, already active, or impossible to move. That single
 * rule is what defeats all three ways this used to stall:
 *
 *   - a first page of already-migrated rows consuming the whole batch;
 *   - malformed or unreadable rows, which can never leave the candidate set,
 *     sitting in front of rows that could have been moved;
 *   - a spent scan budget with nowhere to resume from, so the next call began
 *     again at the beginning and re-walked the same immovable prefix.
 *
 * The cursor is returned as `nextCursor` and consumed by `reEncryptAll`, so
 * bounded work is genuinely bounded *and* genuinely finishes. Memory stays at
 * one page; `exhausted` says whether the end was reached.
 *
 * Note what is deliberately **not** part of this: narrowing the candidate set
 * in SQL. That optimisation existed and was removed — see the note above
 * `KeyUsage` for why a `startsWith` filter on the active-key prefix was unsafe
 * across the two database providers this repository supports.
 *
 * **Never reverting a concurrent write.** Re-encryption is read-then-write, and
 * between those two steps a vendor can change their bank details or an
 * administrator can re-enrol. Writing back by id alone would overwrite that
 * with the stale plaintext this pass happens to be holding — silent data loss
 * that looks like a successful rotation. Every write is therefore a
 * compare-and-swap against the exact ciphertext that was read; a row that moved
 * underneath us is left alone for the next pass, which will find it already on
 * the active key.
 *
 * **Not hiding what it cannot read, and not dying on it either.** A non-null
 * encrypted column that is not a parseable envelope, or that names a key this
 * deployment no longer holds, is counted and reported — never skipped silently,
 * and never allowed to abort the pass. Both mean corruption or a key removed
 * too early, both must block key destruction, and neither may stop the rows
 * behind them from being rotated. `decrypt` throwing straight out of a pass
 * used to make one row under a destroyed key halt the entire rotation.
 *
 * ## Why the survey needs no key material
 *
 * `envelopeKeyId` parses the id out of the envelope prefix, so surveying a
 * table needs no cryptography and no key. `surveyKeyUsage` therefore takes
 * **key ids only** (`KeyringIdentity`), not a `Keyring`. That is not a
 * decoration: it means the survey can genuinely be run by an operator who holds
 * no key material, and the type system enforces it rather than a comment
 * claiming it.
 *
 * ## What is deliberately not here
 *
 * There is no scheduler, no batching daemon, and no HTTP route. Rotation is an
 * infrequent, supervised operation with a runbook (`docs/KEY_MANAGEMENT.md`),
 * not something that should be able to start itself. These are the primitives
 * that runbook drives.
 */

import {
  decrypt,
  encrypt,
  envelopeKeyId,
  type Keyring,
} from '@dash/domain/envelope';
import type { PrismaClient } from '@dash/db';

/** Every encrypted column, with the context its ciphertext is bound to. */
export const ENCRYPTED_FIELDS = [
  { model: 'Identity', column: 'mfaSecretCipher', purpose: 'mfa_totp_secret' },
  { model: 'Identity', column: 'mfaPendingCipher', purpose: 'mfa_totp_secret' },
  { model: 'Vendor', column: 'bankAccountCipher', purpose: 'vendor_bank_account' },
  { model: 'RiderPayoutAccount', column: 'accountCipher', purpose: 'rider_bank_account' },
  { model: 'PaymentMethod', column: 'tokenCipher', purpose: 'customer_payment_method' },
] as const;

/**
 * What a survey needs to know about the keyring: which ids exist, not what they
 * contain.
 *
 * Deliberately not a `Keyring`. Surveying reads key ids out of envelope
 * prefixes and never decrypts, so requiring the keys themselves would hand key
 * material to an operation that has no use for it — and would make the claim
 * in the runbook, that a survey can be run without holding a key, untrue.
 */
export interface KeyringIdentity {
  readonly activeKeyId: string;
  /** Every id the deployment holds a key for, active included. */
  readonly heldKeyIds: readonly string[];
}

/** Reduce a keyring to the ids a survey needs, discarding the key bytes. */
export function keyringIdentity(keyring: Keyring): KeyringIdentity {
  return {
    activeKeyId: keyring.active.keyId,
    heldKeyIds: [keyring.active.keyId, ...keyring.retired.map((entry) => entry.keyId)],
  };
}

/**
 * Why the stale set is **not** narrowed in SQL.
 *
 * An earlier version excluded rows already on the active key with a Prisma
 * `startsWith: 'v1.<activeKeyId>.'` filter, so a pass only ever fetched rows
 * that needed work. That was fast, and it was wrong.
 *
 * Prisma compiles `startsWith` to SQL `LIKE`, and `KEY_ID_PATTERN` permits `_`
 * — which is LIKE's single-character wildcard. With an active key id of `k_1`
 * the intended literal prefix `v1.k_1.` becomes a pattern that also matches
 * `v1.ka1.`, `v1.kX1.`, and every other one-character variant. A row written by
 * a genuinely different, still-retired key was therefore excluded from the
 * stale set before `envelopeKeyId` ever saw it: invisible to rotation,
 * impossible to migrate, and reported as `exhausted` — the pass looked finished
 * while the row it could never reach kept the old key alive for ever.
 *
 * Escaping the pattern was rejected. LIKE escaping is not identical across
 * SQLite and PostgreSQL, this repository deliberately runs both, and a fix that
 * is correct only because one provider happens to behave a certain way is a
 * defect waiting for the other one. Restricting the key-id character set was
 * rejected too: the envelope format already declares `_` legal, and silently
 * narrowing it would strand any existing envelope or retired key that uses one.
 *
 * So the filter is gone. The walk selects rows whose ciphertext is merely
 * non-null and lets `rotateValue` do the exact, literal key-id comparison in
 * application code, where `_` is just a character. The continuation cursor
 * already guarantees forward progress, so correctness never depended on the SQL
 * exclusion — only speed did. A pass now scans already-active rows as well and
 * counts them separately; that costs reads on a mostly-migrated table and buys
 * a comparison that cannot be wrong.
 */

export interface KeyUsage {
  readonly model: string;
  readonly column: string;
  /** Rows per key id. A key id absent from the keyring is still counted. */
  readonly byKeyId: Readonly<Record<string, number>>;
  /**
   * Non-null values that are not parseable envelopes at all.
   *
   * A count, never the values. Reporting the content of a column that failed to
   * parse would be the one place this module printed something that might be
   * plaintext.
   */
  readonly malformed: number;
}

export interface RotationSurvey {
  readonly activeKeyId: string;
  readonly usage: readonly KeyUsage[];
  /** Rows written under any key other than the active one. */
  readonly rowsNeedingReEncryption: number;
  /**
   * Key ids found in stored data that the keyring does not hold.
   *
   * Non-empty means rows are **already** unreadable. That is an incident, not a
   * rotation step: the key was removed too early, or a restore brought back a
   * database without its matching keyring.
   */
  readonly unknownKeyIds: readonly string[];
  /**
   * Non-null encrypted values that are not envelopes this build can parse.
   *
   * Counted per field so an operator knows where to look, without this ever
   * emitting the value itself.
   */
  readonly malformedValues: number;
  /**
   * True when every stored value is under the active key and every stored value
   * parses, so retiring and destroying every other key is safe.
   */
  readonly safeToRetireOtherKeys: boolean;
}

interface Tally {
  readonly byKeyId: Record<string, number>;
  readonly malformed: number;
}

function tally(values: readonly (string | null)[]): Tally {
  const byKeyId: Record<string, number> = {};
  let malformed = 0;

  for (const value of values) {
    // `null` is absent — the column was never written. An empty *string* is
    // not: something wrote it, it is not a parseable envelope, and no key will
    // ever open it. Skipping it here made the survey disagree with
    // `rotateValue`, which already classes '' as malformed, and let
    // `safeToRetireOtherKeys` report true over the top of it.
    if (value === null) continue;

    const keyId = envelopeKeyId(value);
    if (keyId === null) {
      // Present, non-empty, and not an envelope. Counted rather than skipped:
      // an unreadable value that nothing reports is one that blocks nothing,
      // and key destruction would proceed over the top of it.
      malformed += 1;
      continue;
    }

    byKeyId[keyId] = (byKeyId[keyId] ?? 0) + 1;
  }

  return { byKeyId, malformed };
}

/**
 * Count which key wrote each stored ciphertext.
 *
 * Takes key **ids**, never keys. Nothing here decrypts, so an operator running
 * this is not handed key material — call `keyringIdentity(keyring)` at a site
 * that already holds one, or supply the ids from configuration directly.
 */
export async function surveyKeyUsage(
  prisma: PrismaClient,
  identity: KeyringIdentity,
): Promise<RotationSurvey> {
  const identities = await prisma.identity.findMany({
    select: { mfaSecretCipher: true, mfaPendingCipher: true },
  });
  const vendors = await prisma.vendor.findMany({ select: { bankAccountCipher: true } });
  const riderPayouts = await prisma.riderPayoutAccount.findMany({ select: { accountCipher: true } });
  const paymentMethods = await prisma.paymentMethod.findMany({ select: { tokenCipher: true } });

  const tallies: { model: string; column: string; tally: Tally }[] = [
    {
      model: 'Identity',
      column: 'mfaSecretCipher',
      tally: tally(identities.map((row) => row.mfaSecretCipher)),
    },
    {
      model: 'Identity',
      column: 'mfaPendingCipher',
      tally: tally(identities.map((row) => row.mfaPendingCipher)),
    },
    {
      model: 'Vendor',
      column: 'bankAccountCipher',
      tally: tally(vendors.map((row) => row.bankAccountCipher)),
    },
    {
      model: 'RiderPayoutAccount',
      column: 'accountCipher',
      tally: tally(riderPayouts.map((row) => row.accountCipher)),
    },
    {
      model: 'PaymentMethod',
      column: 'tokenCipher',
      tally: tally(paymentMethods.map((row) => row.tokenCipher)),
    },
  ];

  const usage: KeyUsage[] = tallies.map((entry) => ({
    model: entry.model,
    column: entry.column,
    byKeyId: entry.tally.byKeyId,
    malformed: entry.tally.malformed,
  }));

  const held = new Set(identity.heldKeyIds);

  let rowsNeedingReEncryption = 0;
  let malformedValues = 0;
  const unknownKeyIds = new Set<string>();

  for (const field of usage) {
    malformedValues += field.malformed;
    for (const [keyId, count] of Object.entries(field.byKeyId)) {
      if (keyId !== identity.activeKeyId) rowsNeedingReEncryption += count;
      if (!held.has(keyId)) unknownKeyIds.add(keyId);
    }
  }

  return {
    activeKeyId: identity.activeKeyId,
    usage,
    rowsNeedingReEncryption,
    unknownKeyIds: [...unknownKeyIds].sort(),
    malformedValues,
    // A malformed value keeps this closed. It cannot be re-encrypted, so it
    // will never clear on its own, and destroying keys over the top of it
    // removes the only chance of ever recovering whatever it was.
    safeToRetireOtherKeys:
      rowsNeedingReEncryption === 0 && unknownKeyIds.size === 0 && malformedValues === 0,
  };
}

/**
 * What happened to one value.
 *
 * Two distinct ways a value can be **unmovable**, and keeping them apart is the
 * point:
 *
 *   - `malformed` — the stored value never was an envelope. No key would have
 *     opened it. Corruption, a truncated write, or a foreign format.
 *   - `unreadable` — it is a well-formed envelope naming a key this deployment
 *     does not hold, or one that fails authentication. Usually a retired key
 *     destroyed too early, or a restore that brought back a database without
 *     its matching keyring.
 *
 * Neither can ever be moved, and neither may abort a pass over thousands of
 * good rows. `unreadable` in particular used to throw straight out of the pass:
 * one row under a destroyed key stopped the entire rotation.
 */
type RotationOutcome =
  | { readonly kind: 'already_active' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'rotated'; readonly ciphertext: string };

/**
 * Move one value onto the active key.
 *
 * Never throws for a value it cannot open. The caller counts the outcome and
 * carries on, because the alternative — aborting — means one unreadable row
 * blocks every readable one behind it.
 *
 * The plaintext exists only inside this function. It is never returned, logged,
 * or handed to a caller — a rotation has no business seeing the values it
 * moves, and the surrounding code is easier to trust when it cannot. The caught
 * error is deliberately not propagated or logged here either: its message names
 * a key id, and the survey is the place that reports those.
 */
function rotateValue(
  ciphertext: string,
  keyring: Keyring,
  context: { purpose: string; subjectId: string },
): RotationOutcome {
  const keyId = envelopeKeyId(ciphertext);
  if (keyId === null) return { kind: 'malformed' };
  if (keyId === keyring.active.keyId) return { kind: 'already_active' };

  try {
    const opened = decrypt(ciphertext, keyring, context);
    return { kind: 'rotated', ciphertext: encrypt(opened.plaintext, keyring, context) };
  } catch {
    // `unknown_key` (the key is gone), `decryption_failed` (wrong context or
    // tampering), or `unsupported_version`. All are permanent for this pass and
    // all are reported by the survey, which is where an operator looks.
    return { kind: 'unreadable' };
  }
}

export interface ReEncryptionResult {
  /** Rows examined by this pass, including ones it could not move. */
  readonly scanned: number;
  readonly reEncrypted: number;
  /**
   * Rows whose ciphertext changed between the read and the write, so the
   * compare-and-swap declined to overwrite it. Not an error: the concurrent
   * writer used the active key, so there is nothing left to do.
   */
  readonly skippedConcurrentWrite: number;
  /**
   * Rows examined that were already written by the active key.
   *
   * Expected and uninteresting — the walk no longer excludes them in SQL, so
   * every pass sees them. Counted separately from `skippedConcurrentWrite`
   * because lumping the two together would make a routine re-scan look like
   * widespread write contention.
   */
  readonly alreadyActive: number;
  /** Non-null values that were not parseable envelopes. Left untouched. */
  readonly malformed: number;
  /**
   * Well-formed envelopes that could not be opened — the key is not held, or
   * the value fails authentication. Left untouched, and an incident.
   */
  readonly unreadable: number;
  /**
   * True when the pass walked the whole stale set rather than stopping at its
   * limits. False means there is more to do and a further pass is needed.
   */
  readonly exhausted: boolean;
  /**
   * Where a following pass must resume: the id of the last row examined, or
   * null when the walk reached the end.
   *
   * This is what makes bounded operation actually terminate. Without it, a pass
   * that spent its whole scan budget on rows it could not move returned
   * `exhausted: false` and nothing else, so the next call started again at the
   * beginning, scanned the same unmovable rows, and the movable row behind them
   * was never reached — bounded work that could never finish. Resuming *after*
   * the last scanned id is the difference between a budget and a wall.
   */
  readonly nextCursor: string | null;
}

const EMPTY_RESULT: ReEncryptionResult = {
  scanned: 0,
  reEncrypted: 0,
  skippedConcurrentWrite: 0,
  alreadyActive: 0,
  malformed: 0,
  unreadable: 0,
  exhausted: true,
  nextCursor: null,
};

/**
 * Knobs a supervised pass may set.
 *
 * `pageSize` and `scanBudget` are overridable chiefly so tests can force
 * multi-page walks and budget exhaustion without creating thousands of rows —
 * a test that never crosses either boundary cannot tell whether the cursor
 * advances at all, which is the property they exist to provide.
 */
export interface RotationPassOptions {
  /** Stop after moving this many rows. */
  readonly limit?: number;
  /** Rows per database round trip. */
  readonly pageSize?: number;
  /** Rows examined before the pass gives up and reports `exhausted: false`. */
  readonly scanBudget?: number;
  /** Resume after this id. Pass a previous result's `nextCursor`. */
  readonly startAfterId?: string | null;
}

/**
 * What one row's attempted move came to.
 *
 * `concurrent` is the compare-and-swap declining because the stored value
 * changed under us; `already_active` is the same situation noticed a moment
 * earlier, before the write was attempted. Both mean somebody else got there
 * first, and both are reported together.
 */
type MoveResult = RotationOutcome['kind'] | 'concurrent';

/**
 * Rows fetched per database round trip while walking the stale set.
 *
 * Overridable per call so tests can force multi-page walks without creating
 * hundreds of rows. A test that never crosses a page boundary cannot tell
 * whether the cursor advances at all — which is exactly the property the
 * pagination exists to provide.
 */
export const DEFAULT_PAGE_SIZE = 200;

/**
 * How many rows one pass will examine before giving up and reporting
 * `exhausted: false`.
 *
 * Only reachable when the stale set is dominated by rows that cannot be moved,
 * which is itself an incident. Without the bound, a table with a very large
 * number of unreadable rows would make a single supervised pass run for as long
 * as it took to walk all of them.
 */
const SCAN_BUDGET_MULTIPLIER = 100;

/**
 * Walk the stale rows for one column, moving what can be moved.
 *
 * **Keyset pagination, not `take: limit`.** This is the second half of the
 * forward-progress guarantee, and the half the first fix missed. Excluding rows
 * already on the active key stops *migrated* rows consuming the batch — but a
 * malformed or unreadable row can never be migrated, so it never leaves the
 * stale set. With `limit` or more of those ahead of the good rows, a fixed
 * `take: limit` selects the same unmovable rows on every pass, moves nothing,
 * and the good rows behind them are never reached: the original starvation bug
 * arrived at through a different door.
 *
 * Stepping the cursor past every row examined — moved or not — is what gets
 * past them. `id: { gt: lastId }` is used rather than Prisma's `cursor`,
 * because a cursor row that no longer matches the filter (which is exactly what
 * a just-re-encrypted row is) is not a case worth relying on.
 *
 * Memory stays bounded: one page at a time, never the table.
 */
async function walkStaleRows<Row extends { id: string }>(
  fetchPage: (lastId: string | null, take: number) => Promise<Row[]>,
  moveRow: (row: Row) => Promise<MoveResult>,
  limit: number,
  pageSize: number,
  scanBudget: number,
  startAfterId: string | null,
): Promise<ReEncryptionResult> {
  let lastId: string | null = startAfterId;
  let scanned = 0;
  let reEncrypted = 0;
  let skippedConcurrentWrite = 0;
  let alreadyActive = 0;
  let malformed = 0;
  let unreadable = 0;
  let exhausted = false;

  while (reEncrypted < limit && scanned < scanBudget) {
    const rows = await fetchPage(lastId, pageSize);
    if (rows.length === 0) {
      exhausted = true;
      break;
    }

    for (const row of rows) {
      lastId = row.id;
      scanned += 1;

      const outcome = await moveRow(row);
      if (outcome === 'malformed') malformed += 1;
      else if (outcome === 'unreadable') unreadable += 1;
      else if (outcome === 'already_active') alreadyActive += 1;
      else if (outcome === 'concurrent') skippedConcurrentWrite += 1;
      else reEncrypted += 1;

      if (reEncrypted >= limit || scanned >= scanBudget) break;
    }

    // A short page means the stale set ended here, but only if the inner loop
    // consumed it rather than breaking out on a limit.
    if (rows.length < pageSize && reEncrypted < limit && scanned < scanBudget) {
      exhausted = true;
      break;
    }
  }

  return {
    scanned,
    reEncrypted,
    skippedConcurrentWrite,
    alreadyActive,
    malformed,
    unreadable,
    exhausted,
    // Null once the stale set is finished, so a caller can tell "done" from
    // "stopped early" without inspecting two fields.
    nextCursor: exhausted ? null : lastId,
  };
}

/**
 * Re-encrypt vendor payout details onto the active key.
 *
 * Selects only rows *not* already written by the active key, so a pass always
 * does `limit` rows of real work and repeated passes always advance. Bounded by
 * `limit` so a rotation over a large table proceeds in supervised passes rather
 * than one transaction long enough to matter.
 *
 * Each row is written on its own, under a compare-and-swap against the exact
 * ciphertext that was read. A failure part-way leaves earlier rows correctly
 * re-encrypted and later rows readable under their original key, which is
 * exactly the state a re-run resumes from.
 */
export async function reEncryptVendorPayouts(
  prisma: PrismaClient,
  keyring: Keyring,
  options: RotationPassOptions = {},
): Promise<ReEncryptionResult> {
  const {
    limit = 500,
    pageSize = DEFAULT_PAGE_SIZE,
    scanBudget = Math.max(limit, 1) * SCAN_BUDGET_MULTIPLIER,
    startAfterId = null,
  } = options;
  return walkStaleRows(
    (lastId, take) =>
      prisma.vendor.findMany({
        where: {
          // Deliberately only "has a ciphertext". Which key wrote it is decided
          // by `rotateValue` in application code, not by a SQL LIKE pattern —
          // see the note above `KeyUsage`.
          bankAccountCipher: { not: null },
          ...(lastId === null ? {} : { id: { gt: lastId } }),
        },
        select: { id: true, bankAccountCipher: true },
        orderBy: { id: 'asc' },
        take,
      }),
    async (vendor) => {
      const original = vendor.bankAccountCipher!;
      const outcome = rotateValue(original, keyring, {
        purpose: 'vendor_bank_account',
        subjectId: vendor.id,
      });

      if (outcome.kind !== 'rotated') return outcome.kind;

      // Compare-and-swap. `updateMany` lets the WHERE clause carry the value we
      // read, so a vendor who changed their bank details since then keeps their
      // change instead of having this pass write the old one back over it.
      const written = await prisma.vendor.updateMany({
        where: { id: vendor.id, bankAccountCipher: original },
        data: { bankAccountCipher: outcome.ciphertext },
      });

      return written.count === 0 ? 'concurrent' : 'rotated';
    },
    limit,
    pageSize,
    scanBudget,
    startAfterId,
  );
}

/**
 * Re-encrypt rider payout accounts onto the active key.
 *
 * The same pass as vendor payouts: page through rows by id, rotate each in
 * application code, and write it back under a compare-and-swap against the
 * exact ciphertext read, so a rider who changed their account meanwhile keeps
 * the change.
 */
export async function reEncryptRiderPayouts(
  prisma: PrismaClient,
  keyring: Keyring,
  options: RotationPassOptions = {},
): Promise<ReEncryptionResult> {
  const {
    limit = 500,
    pageSize = DEFAULT_PAGE_SIZE,
    scanBudget = Math.max(limit, 1) * SCAN_BUDGET_MULTIPLIER,
    startAfterId = null,
  } = options;
  return walkStaleRows(
    (lastId, take) =>
      prisma.riderPayoutAccount.findMany({
        where: lastId === null ? {} : { id: { gt: lastId } },
        select: { id: true, riderId: true, accountCipher: true },
        orderBy: { id: 'asc' },
        take,
      }),
    async (account) => {
      const original = account.accountCipher;
      const outcome = rotateValue(original, keyring, {
        purpose: 'rider_bank_account',
        subjectId: account.riderId,
      });

      if (outcome.kind !== 'rotated') return outcome.kind;

      const written = await prisma.riderPayoutAccount.updateMany({
        where: { id: account.id, accountCipher: original },
        data: { accountCipher: outcome.ciphertext },
      });

      return written.count === 0 ? 'concurrent' : 'rotated';
    },
    limit,
    pageSize,
    scanBudget,
    startAfterId,
  );
}

/**
 * Re-encrypt saved-card tokens onto the active key. A removed card's token is
 * moved too: a key cannot be retired while any row still names it.
 */
export async function reEncryptPaymentMethods(
  prisma: PrismaClient,
  keyring: Keyring,
  options: RotationPassOptions = {},
): Promise<ReEncryptionResult> {
  const {
    limit = 500,
    pageSize = DEFAULT_PAGE_SIZE,
    scanBudget = Math.max(limit, 1) * SCAN_BUDGET_MULTIPLIER,
    startAfterId = null,
  } = options;
  return walkStaleRows(
    (lastId, take) =>
      prisma.paymentMethod.findMany({
        where: lastId === null ? {} : { id: { gt: lastId } },
        select: { id: true, customerId: true, tokenCipher: true },
        orderBy: { id: 'asc' },
        take,
      }),
    async (method) => {
      const original = method.tokenCipher;
      const outcome = rotateValue(original, keyring, {
        purpose: 'customer_payment_method',
        subjectId: method.customerId,
      });

      if (outcome.kind !== 'rotated') return outcome.kind;

      const written = await prisma.paymentMethod.updateMany({
        where: { id: method.id, tokenCipher: original },
        data: { tokenCipher: outcome.ciphertext },
      });

      return written.count === 0 ? 'concurrent' : 'rotated';
    },
    limit,
    pageSize,
    scanBudget,
    startAfterId,
  );
}

/**
 * Re-encrypt stored TOTP secrets onto the active key.
 *
 * Both the confirmed secret and any pending enrolment, because a key cannot be
 * retired while either still names it. Missing this column is precisely how a
 * rotation looks complete and is not: payout details would be surveyed, moved,
 * and signed off while every administrator's second factor still sat under the
 * key about to be destroyed.
 *
 * The two columns are selected and swapped independently. Guarding both in one
 * statement would mean a concurrent change to either one blocked the rotation
 * of the other.
 */
export async function reEncryptMfaSecrets(
  prisma: PrismaClient,
  keyring: Keyring,
  options: RotationPassOptions = {},
): Promise<ReEncryptionResult> {
  const {
    limit = 500,
    pageSize = DEFAULT_PAGE_SIZE,
    scanBudget = Math.max(limit, 1) * SCAN_BUDGET_MULTIPLIER,
    startAfterId = null,
  } = options;
  // Only "has a ciphertext" — the key-id comparison happens in `rotateValue`.
  const hasCipher = (column: 'mfaSecretCipher' | 'mfaPendingCipher') => ({
    [column]: { not: null },
  });

  // An identity has two encrypted columns, so `malformed` and `unreadable` are
  // counted per column here and substituted into the walker's row-level totals
  // below. Counting them per row would under-report an identity whose confirmed
  // and pending secrets are both corrupt.
  let malformedColumns = 0;
  let unreadableColumns = 0;

  const result = await walkStaleRows(
    (lastId, take) =>
      prisma.identity.findMany({
        where: {
          OR: [hasCipher('mfaSecretCipher'), hasCipher('mfaPendingCipher')],
          ...(lastId === null ? {} : { id: { gt: lastId } }),
        },
        select: { id: true, mfaSecretCipher: true, mfaPendingCipher: true },
        orderBy: { id: 'asc' },
        take,
      }),
    async (identity) => {
      const context = { purpose: 'mfa_totp_secret', subjectId: identity.id };
      let moved = false;
      let blocked = false;

      for (const column of ['mfaSecretCipher', 'mfaPendingCipher'] as const) {
        const original = identity[column];
        if (original === null) continue;

        const outcome = rotateValue(original, keyring, context);

        if (outcome.kind === 'malformed') {
          malformedColumns += 1;
          continue;
        }
        if (outcome.kind === 'unreadable') {
          unreadableColumns += 1;
          continue;
        }
        if (outcome.kind === 'already_active') {
          blocked = true;
          continue;
        }

        // Each column is swapped under its own compare-and-swap. Guarding both
        // in one statement would mean a concurrent change to either blocked the
        // rotation of the other.
        const written = await prisma.identity.updateMany({
          where: { id: identity.id, [column]: original },
          data: { [column]: outcome.ciphertext },
        });

        if (written.count === 0) blocked = true;
        else moved = true;
      }

      if (moved) return 'rotated';
      if (blocked) return 'concurrent';
      // Nothing moved and nothing was contended, so every stale column on this
      // row was unmovable. Reported as such so the walker steps past it.
      return unreadableColumns > 0 ? 'unreadable' : 'malformed';
    },
    limit,
    pageSize,
    scanBudget,
    startAfterId,
  );

  return { ...result, malformed: malformedColumns, unreadable: unreadableColumns };
}

/**
 * Passes over everything encrypted at rest, until nothing is left to move.
 *
 * `maxPasses` bounds the loop so a row that cannot be moved — malformed, or
 * repeatedly rewritten by a concurrent writer — cannot spin forever. Reaching
 * the cap is not an error; the returned survey says what is still outstanding.
 *
 * The survey afterwards is what the runbook gates key destruction on, and the
 * only thing it should.
 */
export async function reEncryptAll(
  prisma: PrismaClient,
  keyring: Keyring,
  options: RotationPassOptions & { readonly maxPasses?: number } = {},
): Promise<{
  readonly payouts: ReEncryptionResult;
  readonly riderPayouts: ReEncryptionResult;
  readonly paymentMethods: ReEncryptionResult;
  readonly mfa: ReEncryptionResult;
  readonly passes: number;
  readonly survey: RotationSurvey;
}> {
  const { maxPasses = 100, ...passOptions } = options;

  type Mutable = {
    scanned: number;
    reEncrypted: number;
    skippedConcurrentWrite: number;
    alreadyActive: number;
    malformed: number;
    unreadable: number;
    exhausted: boolean;
    nextCursor: string | null;
  };

  const payouts: Mutable = { ...EMPTY_RESULT };
  const riderPayouts: Mutable = { ...EMPTY_RESULT };
  const paymentMethods: Mutable = { ...EMPTY_RESULT };
  const mfa: Mutable = { ...EMPTY_RESULT };

  // The continuation cursors. Each pass resumes *after* the last row the
  // previous one examined, which is what makes a bounded scan budget a budget
  // rather than a wall: rows that can never be moved are stepped over once and
  // never block the movable rows behind them again.
  let payoutCursor: string | null = passOptions.startAfterId ?? null;
  let riderPayoutCursor: string | null = passOptions.startAfterId ?? null;
  let paymentMethodCursor: string | null = passOptions.startAfterId ?? null;
  let mfaCursor: string | null = passOptions.startAfterId ?? null;
  let payoutDone = false;
  let riderPayoutDone = false;
  let paymentMethodDone = false;
  let mfaDone = false;

  let passes = 0;

  for (; passes < maxPasses; passes += 1) {
    if (!payoutDone) {
      const pass = await reEncryptVendorPayouts(prisma, keyring, {
        ...passOptions,
        startAfterId: payoutCursor,
      });
      payouts.scanned += pass.scanned;
      payouts.reEncrypted += pass.reEncrypted;
      payouts.skippedConcurrentWrite += pass.skippedConcurrentWrite;
      payouts.alreadyActive += pass.alreadyActive;
      // Per-pass counts of the same unmovable rows. Summed across passes they
      // would multiply one corrupt row by the number of passes that walked
      // over it, so each pass's contribution is added only for rows it saw for
      // the first time — which, with the cursor advancing, is all of them.
      payouts.malformed += pass.malformed;
      payouts.unreadable += pass.unreadable;
      payouts.exhausted = pass.exhausted;
      payouts.nextCursor = pass.nextCursor;
      payoutCursor = pass.nextCursor;
      payoutDone = pass.exhausted;
    }

    if (!mfaDone) {
      const pass = await reEncryptMfaSecrets(prisma, keyring, {
        ...passOptions,
        startAfterId: mfaCursor,
      });
      mfa.scanned += pass.scanned;
      mfa.reEncrypted += pass.reEncrypted;
      mfa.skippedConcurrentWrite += pass.skippedConcurrentWrite;
      mfa.alreadyActive += pass.alreadyActive;
      mfa.malformed += pass.malformed;
      mfa.unreadable += pass.unreadable;
      mfa.exhausted = pass.exhausted;
      mfa.nextCursor = pass.nextCursor;
      mfaCursor = pass.nextCursor;
      mfaDone = pass.exhausted;
    }

    if (!riderPayoutDone) {
      const pass = await reEncryptRiderPayouts(prisma, keyring, {
        ...passOptions,
        startAfterId: riderPayoutCursor,
      });
      riderPayouts.scanned += pass.scanned;
      riderPayouts.reEncrypted += pass.reEncrypted;
      riderPayouts.skippedConcurrentWrite += pass.skippedConcurrentWrite;
      riderPayouts.alreadyActive += pass.alreadyActive;
      riderPayouts.malformed += pass.malformed;
      riderPayouts.unreadable += pass.unreadable;
      riderPayouts.exhausted = pass.exhausted;
      riderPayouts.nextCursor = pass.nextCursor;
      riderPayoutCursor = pass.nextCursor;
      riderPayoutDone = pass.exhausted;
    }

    if (!paymentMethodDone) {
      const pass = await reEncryptPaymentMethods(prisma, keyring, {
        ...passOptions,
        startAfterId: paymentMethodCursor,
      });
      paymentMethods.scanned += pass.scanned;
      paymentMethods.reEncrypted += pass.reEncrypted;
      paymentMethods.skippedConcurrentWrite += pass.skippedConcurrentWrite;
      paymentMethods.alreadyActive += pass.alreadyActive;
      paymentMethods.malformed += pass.malformed;
      paymentMethods.unreadable += pass.unreadable;
      paymentMethods.exhausted = pass.exhausted;
      paymentMethods.nextCursor = pass.nextCursor;
      paymentMethodCursor = pass.nextCursor;
      paymentMethodDone = pass.exhausted;
    }

    // Every walk has reached the end of its stale set. Anything still
    // outstanding is unmovable, and the survey below is what reports it.
    //
    // Deliberately *not* "every pass moved nothing": a pass that spends its
    // whole budget stepping over corrupt rows moves nothing and has not
    // finished, and stopping there was the starvation this cursor removes.
    if (payoutDone && mfaDone && riderPayoutDone && paymentMethodDone) {
      passes += 1;
      break;
    }
  }

  return {
    payouts,
    riderPayouts,
    paymentMethods,
    mfa,
    passes,
    survey: await surveyKeyUsage(prisma, keyringIdentity(keyring)),
  };
}
