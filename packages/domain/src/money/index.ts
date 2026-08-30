/**
 * Money.
 *
 * Every monetary value in DASH APP is an integer count of the currency's minor
 * unit — kobo for NGN. There is no floating-point money anywhere in this
 * codebase, in the database, or on the wire. See ADR-0006.
 *
 * `Kobo` is a branded type: a plain `number` will not type-check where `Kobo` is
 * expected, so an untrusted client value cannot silently become a price.
 */

declare const KOBO_BRAND: unique symbol;

/** An integer count of kobo. ₦1 = 100 kobo. Always safe-integer, may be negative. */
export type Kobo = number & { readonly [KOBO_BRAND]: 'Kobo' };

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * The only way to mint a `Kobo`. Rejects anything that is not a safe integer,
 * which is the single check that keeps float drift out of the system.
 */
export function kobo(value: number): Kobo {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`Money must be a whole number of kobo, received ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`Money value ${value} exceeds the safe integer range`);
  }
  // Normalise negative zero. `-0` arises naturally from negating a zero balance,
  // and it is poison downstream: `Object.is(-0, 0)` is false, so a settled
  // account would fail an equality check, and it formats as "-₦0.00" in the UI.
  // Collapsing it here means no `-0` can exist anywhere in the system.
  return (Object.is(value, -0) ? 0 : value) as Kobo;
}

/** Zero, for reducers and defaults. */
export const ZERO: Kobo = 0 as Kobo;

/** Parse a value that arrived from JSON, the database, or an env var. */
export function parseKobo(value: unknown): Kobo {
  if (typeof value === 'number') return kobo(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return kobo(Number(value));
  throw new MoneyError(`Cannot read ${JSON.stringify(value)} as kobo`);
}

/** Convert naira to kobo. Rejects fractions finer than a kobo (₦1.005). */
export function naira(amount: number): Kobo {
  const asKobo = Math.round(amount * 100);
  if (Math.abs(amount * 100 - asKobo) > 1e-6) {
    throw new MoneyError(`₦${amount} is finer than one kobo and cannot be represented`);
  }
  return kobo(asKobo);
}

export function add(...values: readonly Kobo[]): Kobo {
  return kobo(values.reduce<number>((sum, v) => sum + v, 0));
}

export function subtract(a: Kobo, b: Kobo): Kobo {
  return kobo(a - b);
}

export function negate(a: Kobo): Kobo {
  return kobo(-a);
}

/**
 * Multiply money by a plain number and round half-up to the nearest kobo.
 *
 * Half-up (not banker's rounding) is deliberate: it matches what Nigerian
 * customers see on receipts elsewhere, and consistency with expectation matters
 * more here than the tiny statistical bias banker's rounding avoids.
 *
 * The `toPrecision(15)` step is not decoration. IEEE-754 evaluates
 * `100 * 1.005` as `100.49999999999999`, so a naive `Math.round` returns 100
 * where the arithmetic says 101 — a kobo lost on every such calculation, always
 * in the platform's favour and never the customer's. Collapsing to 15
 * significant digits (comfortably inside a double's ~15.95 digits of real
 * precision) discards the representation error before rounding.
 */
export function multiply(amount: Kobo, factor: number): Kobo {
  if (!Number.isFinite(factor)) {
    throw new MoneyError(`Cannot multiply money by ${factor}`);
  }
  const corrected = Number((amount * factor).toPrecision(15));
  return kobo(Math.sign(corrected) * Math.round(Math.abs(corrected)));
}

/**
 * Apply a percentage in basis points (1 bp = 0.01%). Commission of 18% is 1800.
 *
 * Basis points rather than a float percentage because commission rates are
 * configured by humans in an admin UI and stored in the database; an integer
 * cannot drift, and 18% is exactly 1800 forever.
 *
 * Computed entirely in integer arithmetic — `amount * basisPoints` then an
 * integer divide with an explicit half-up remainder test. No float division
 * happens at all, so unlike `multiply` there is no representation error to
 * correct for. This is the path every commission, tax, and service fee takes,
 * so it is the one that must be exact.
 */
export function percentOf(amount: Kobo, basisPoints: number): Kobo {
  if (!Number.isInteger(basisPoints)) {
    throw new MoneyError(`Basis points must be a whole number, received ${basisPoints}`);
  }

  const scaled = amount * basisPoints;
  if (!Number.isSafeInteger(scaled)) {
    // Astronomically large basket; fall back to the corrected float path rather
    // than silently returning a wrong integer.
    return multiply(amount, basisPoints / 10_000);
  }

  const negative = scaled < 0;
  const absolute = Math.abs(scaled);
  const whole = Math.trunc(absolute / 10_000);
  const remainder = absolute % 10_000;
  const rounded = remainder >= 5_000 ? whole + 1 : whole;

  return kobo(negative ? -rounded : rounded);
}

/** Clamp into [min, max]. Used for fee floors and surge caps. */
export function clamp(amount: Kobo, min: Kobo, max: Kobo): Kobo {
  if (min > max) throw new MoneyError(`Clamp floor ${min} exceeds ceiling ${max}`);
  return kobo(Math.min(Math.max(amount, min), max));
}

/** Never below zero. A discount larger than the subtotal must not create a debt. */
export function atLeastZero(amount: Kobo): Kobo {
  return amount < 0 ? ZERO : amount;
}

export function isZero(amount: Kobo): boolean {
  return amount === 0;
}

export function isNegative(amount: Kobo): boolean {
  return amount < 0;
}

/**
 * Split an amount into `parts` as evenly as possible, distributing the remainder
 * one kobo at a time to the earliest parts. The result always sums back to the
 * input exactly — this is what makes it safe for splitting a discount across
 * order lines or a payout across riders.
 */
export function allocate(amount: Kobo, parts: number): Kobo[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new MoneyError(`Cannot split money into ${parts} parts`);
  }
  const base = Math.trunc(amount / parts);
  let remainder = amount - base * parts;
  const step = remainder < 0 ? -1 : 1;
  return Array.from({ length: parts }, () => {
    let share = base;
    if (remainder !== 0) {
      share += step;
      remainder -= step;
    }
    return kobo(share);
  });
}

/**
 * Split an amount proportionally to `weights`, preserving the total exactly.
 * Largest-remainder method: allocate floors, then hand the leftover kobo to the
 * parts with the biggest truncated fraction.
 *
 * Used to apply a basket-level discount back onto individual order lines so that
 * per-line refunds stay consistent with what the customer actually paid.
 */
export function allocateByWeight(amount: Kobo, weights: readonly number[]): Kobo[] {
  if (weights.length === 0) throw new MoneyError('Cannot allocate across zero weights');
  if (weights.some((w) => w < 0 || !Number.isFinite(w))) {
    throw new MoneyError('Allocation weights must be finite and non-negative');
  }

  const total = weights.reduce((sum, w) => sum + w, 0);
  // All-zero weights degrade to an even split rather than dividing by zero.
  if (total === 0) return allocate(amount, weights.length);

  const exact = weights.map((w) => (amount * w) / total);
  const floors = exact.map((value) => Math.trunc(value));
  let remainder = amount - floors.reduce((sum, v) => sum + v, 0);
  const step = remainder < 0 ? -1 : 1;

  const order = exact
    .map((value, index) => ({ index, fraction: Math.abs(value - Math.trunc(value)) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  const result = [...floors];
  for (const { index } of order) {
    if (remainder === 0) break;
    result[index] = (result[index] ?? 0) + step;
    remainder -= step;
  }
  return result.map((v) => kobo(v));
}

/** Human-readable, for receipts and admin screens. `150000` → `"₦1,500.00"`. */
export function formatNaira(amount: Kobo): string {
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const whole = Math.trunc(abs / 100).toLocaleString('en-NG');
  const fraction = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}₦${whole}.${fraction}`;
}

/** Compact form for dense UI (order lists, maps). `150000` → `"₦1,500"`. */
export function formatNairaCompact(amount: Kobo): string {
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const whole = Math.round(abs / 100).toLocaleString('en-NG');
  return `${negative ? '-' : ''}₦${whole}`;
}
