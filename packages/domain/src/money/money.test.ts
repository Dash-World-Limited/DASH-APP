import { describe, expect, it } from 'vitest';
import {
  add,
  allocate,
  allocateByWeight,
  atLeastZero,
  clamp,
  formatNaira,
  formatNairaCompact,
  kobo,
  MoneyError,
  multiply,
  naira,
  negate,
  parseKobo,
  percentOf,
  subtract,
  ZERO,
} from './index.js';

describe('kobo', () => {
  it('accepts whole numbers including zero and negatives', () => {
    expect(kobo(0)).toBe(0);
    expect(kobo(150_000)).toBe(150_000);
    expect(kobo(-500)).toBe(-500);
  });

  it('rejects fractional values — this is the guard against float money', () => {
    expect(() => kobo(10.5)).toThrow(MoneyError);
    expect(() => kobo(0.1 + 0.2)).toThrow(MoneyError);
  });

  it('rejects values beyond the safe integer range', () => {
    expect(() => kobo(Number.MAX_SAFE_INTEGER + 2)).toThrow(MoneyError);
    expect(() => kobo(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
    expect(() => kobo(Number.NaN)).toThrow(MoneyError);
  });
});

describe('naira', () => {
  it('converts naira to kobo', () => {
    expect(naira(1)).toBe(100);
    expect(naira(1500)).toBe(150_000);
    expect(naira(0.5)).toBe(50);
  });

  it('rejects amounts finer than one kobo', () => {
    expect(() => naira(1.005)).toThrow(MoneyError);
  });

  it('handles float representation error without throwing', () => {
    // 19.99 * 100 is 1998.9999999999998 in IEEE-754. Must still give 1999.
    expect(naira(19.99)).toBe(1999);
    expect(naira(0.07)).toBe(7);
    expect(naira(1.1)).toBe(110);
  });
});

describe('parseKobo', () => {
  it('reads numbers and integer strings', () => {
    expect(parseKobo(500)).toBe(500);
    expect(parseKobo('500')).toBe(500);
    expect(parseKobo('-500')).toBe(-500);
  });

  it('rejects anything else', () => {
    expect(() => parseKobo('5.5')).toThrow(MoneyError);
    expect(() => parseKobo(null)).toThrow(MoneyError);
    expect(() => parseKobo({})).toThrow(MoneyError);
    expect(() => parseKobo('abc')).toThrow(MoneyError);
  });
});

describe('arithmetic', () => {
  it('adds, subtracts, negates', () => {
    expect(add(kobo(100), kobo(250), kobo(50))).toBe(400);
    expect(add()).toBe(0);
    expect(subtract(kobo(500), kobo(200))).toBe(300);
    expect(subtract(kobo(200), kobo(500))).toBe(-300);
    expect(negate(kobo(500))).toBe(-500);
  });

  it('multiplies with half-up rounding away from zero', () => {
    expect(multiply(kobo(100), 1.5)).toBe(150);
    // 100 * 1.005 = 100.5 → rounds up to 101
    expect(multiply(kobo(100), 1.005)).toBe(101);
    // Negative amounts round away from zero symmetrically
    expect(multiply(kobo(-100), 1.005)).toBe(-101);
    expect(multiply(kobo(333), 1 / 3)).toBe(111);
  });

  it('rejects non-finite multipliers', () => {
    expect(() => multiply(kobo(100), Number.NaN)).toThrow(MoneyError);
    expect(() => multiply(kobo(100), Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });
});

describe('percentOf', () => {
  it('applies basis points exactly', () => {
    expect(percentOf(kobo(100_000), 1800)).toBe(18_000); // 18%
    expect(percentOf(kobo(100_000), 10_000)).toBe(100_000); // 100%
    expect(percentOf(kobo(100_000), 0)).toBe(0);
    expect(percentOf(kobo(333), 3333)).toBe(111);
  });

  it('rounds exactly half up, in integer arithmetic', () => {
    // 5 kobo at 50% is exactly 2.5 → 3, not 2.
    expect(percentOf(kobo(5), 5000)).toBe(3);
    // Just below the halfway point rounds down.
    expect(percentOf(kobo(1), 4999)).toBe(0);
    expect(percentOf(kobo(1), 5000)).toBe(1);
  });

  it('is symmetric for negative amounts (refund reversals)', () => {
    expect(percentOf(kobo(-5), 5000)).toBe(-3);
    expect(percentOf(kobo(-100_000), 1800)).toBe(-18_000);
  });

  it('never loses a kobo to float representation error', () => {
    // Regression: percentOf once went through a float multiply, where
    // 100 * 0.1005 evaluates to 10.049999999999999 and rounded down to 10.
    expect(percentOf(kobo(100), 1005)).toBe(10);
    // The clearer case — an exact .5 that IEEE-754 renders just under.
    expect(multiply(kobo(100), 1.005)).toBe(101);

    // Commission on every whole-naira basket up to ₦2,000 must equal the
    // integer-exact value, with no drift in either direction.
    for (let nairaAmount = 1; nairaAmount <= 2000; nairaAmount += 1) {
      const basket = naira(nairaAmount);
      const commission = percentOf(basket, 1800);
      const exact = (basket * 1800) / 10_000;
      expect(Math.abs(commission - exact)).toBeLessThanOrEqual(0.5);
    }
  });

  it('rejects fractional basis points', () => {
    expect(() => percentOf(kobo(100), 12.5)).toThrow(MoneyError);
  });
});

describe('clamp and atLeastZero', () => {
  it('clamps into range', () => {
    expect(clamp(kobo(50), kobo(100), kobo(500))).toBe(100);
    expect(clamp(kobo(900), kobo(100), kobo(500))).toBe(500);
    expect(clamp(kobo(300), kobo(100), kobo(500))).toBe(300);
  });

  it('rejects an inverted range rather than silently swapping', () => {
    expect(() => clamp(kobo(300), kobo(500), kobo(100))).toThrow(MoneyError);
  });

  it('floors at zero so a discount cannot create a debt', () => {
    expect(atLeastZero(kobo(-500))).toBe(0);
    expect(atLeastZero(kobo(500))).toBe(500);
    expect(atLeastZero(ZERO)).toBe(0);
  });
});

describe('allocate', () => {
  it('splits evenly when it divides cleanly', () => {
    expect(allocate(kobo(300), 3)).toEqual([100, 100, 100]);
  });

  it('never loses or invents a kobo', () => {
    const parts = allocate(kobo(100), 3);
    expect(parts).toEqual([34, 33, 33]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('handles negatives symmetrically', () => {
    const parts = allocate(kobo(-100), 3);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(-100);
  });

  it('rejects invalid part counts', () => {
    expect(() => allocate(kobo(100), 0)).toThrow(MoneyError);
    expect(() => allocate(kobo(100), -1)).toThrow(MoneyError);
    expect(() => allocate(kobo(100), 2.5)).toThrow(MoneyError);
  });

  it('preserves the total for many random inputs', () => {
    for (let i = 0; i < 200; i += 1) {
      const amount = kobo(Math.floor(Math.random() * 1_000_000));
      const parts = Math.floor(Math.random() * 12) + 1;
      const split = allocate(amount, parts);
      expect(split.reduce((a, b) => a + b, 0)).toBe(amount);
      expect(split).toHaveLength(parts);
    }
  });
});

describe('allocateByWeight', () => {
  it('splits proportionally and preserves the total', () => {
    // A ₦100 discount over lines worth 300 and 700.
    const parts = allocateByWeight(kobo(10_000), [300, 700]);
    expect(parts).toEqual([3000, 7000]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  it('hands leftover kobo to the largest remainders', () => {
    // 100 kobo over three equal lines: 33.33 each, one extra kobo to distribute.
    const parts = allocateByWeight(kobo(100), [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(Math.max(...parts) - Math.min(...parts)).toBe(1);
  });

  it('falls back to an even split when all weights are zero', () => {
    const parts = allocateByWeight(kobo(90), [0, 0, 0]);
    expect(parts).toEqual([30, 30, 30]);
  });

  it('rejects negative or non-finite weights', () => {
    expect(() => allocateByWeight(kobo(100), [-1, 2])).toThrow(MoneyError);
    expect(() => allocateByWeight(kobo(100), [Number.NaN, 2])).toThrow(MoneyError);
    expect(() => allocateByWeight(kobo(100), [])).toThrow(MoneyError);
  });

  it('preserves the total across random weightings', () => {
    for (let i = 0; i < 200; i += 1) {
      const amount = kobo(Math.floor(Math.random() * 500_000));
      const weights = Array.from({ length: Math.floor(Math.random() * 8) + 1 }, () =>
        Math.floor(Math.random() * 1000),
      );
      const split = allocateByWeight(amount, weights);
      expect(split.reduce((a, b) => a + b, 0)).toBe(amount);
    }
  });
});

describe('formatting', () => {
  it('renders naira with kobo precision', () => {
    expect(formatNaira(kobo(150_000))).toBe('₦1,500.00');
    expect(formatNaira(kobo(50))).toBe('₦0.50');
    expect(formatNaira(kobo(0))).toBe('₦0.00');
    expect(formatNaira(kobo(-150_000))).toBe('-₦1,500.00');
    expect(formatNaira(kobo(1))).toBe('₦0.01');
  });

  it('renders a compact form for dense UI', () => {
    expect(formatNairaCompact(kobo(150_000))).toBe('₦1,500');
    expect(formatNairaCompact(kobo(150_050))).toBe('₦1,501');
  });
});
