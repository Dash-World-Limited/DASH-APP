import { describe, expect, it } from 'vitest';
import { kobo, naira } from '../money/index.js';
import {
  computeRiderPay,
  DEFAULT_RIDER_PAY_RULES,
  RIDER_PAY_RULE_VERSION,
  type RiderPayInput,
} from './index.js';

const BASE: RiderPayInput = {
  rules: DEFAULT_RIDER_PAY_RULES,
  vehicleType: 'motorcycle',
  tripMetres: 5000,
  approachMetres: 1000,
  waitingMinutes: 0,
  surgeMultiplier: 1,
  tip: kobo(0),
};

/** The result must always equal the sum of its stated components. */
function sumComponents(result: ReturnType<typeof computeRiderPay>): number {
  return result.components.reduce((total, component) => total + component.amount, 0);
}

describe('computeRiderPay', () => {
  it('stamps the rule version', () => {
    expect(computeRiderPay(BASE).ruleVersion).toBe(RIDER_PAY_RULE_VERSION);
  });

  it('explains every component it pays', () => {
    const result = computeRiderPay(BASE);
    expect(result.components.length).toBeGreaterThan(2);
    for (const component of result.components) {
      expect(component.explanation.length).toBeGreaterThan(5);
    }
  });

  it('always sums to the stated total', () => {
    const result = computeRiderPay({ ...BASE, tip: naira(500) });
    expect(sumComponents(result)).toBe(result.total);
  });

  it('pays base, distance and approach', () => {
    const result = computeRiderPay(BASE);
    // base 300 + (5km × 80) 400 + (1km × 40) 40 = 740, × 1.15 motorcycle = 851
    expect(result.deliveryPay).toBe(naira(851));
  });

  it('pays for the approach leg — a long ride to the vendor is not free', () => {
    const near = computeRiderPay({ ...BASE, approachMetres: 0 });
    const far = computeRiderPay({ ...BASE, approachMetres: 5000 });
    expect(far.deliveryPay).toBeGreaterThan(near.deliveryPay);
  });

  it('never pays below the minimum, however short the trip', () => {
    const result = computeRiderPay({ ...BASE, tripMetres: 100, approachMetres: 0 });
    expect(result.deliveryPay).toBe(DEFAULT_RIDER_PAY_RULES.minimumPay);
    expect(result.components.some((c) => c.name === 'minimum_top_up')).toBe(true);
    expect(sumComponents(result)).toBe(result.total);
  });

  it('caps pay so a GPS glitch cannot produce a five-figure payout', () => {
    const result = computeRiderPay({ ...BASE, tripMetres: 5_000_000 });
    expect(result.deliveryPay).toBe(DEFAULT_RIDER_PAY_RULES.maximumPay);
  });

  it('gives waiting time free for the first five minutes, then pays', () => {
    const brief = computeRiderPay({ ...BASE, waitingMinutes: 5 });
    const long = computeRiderPay({ ...BASE, waitingMinutes: 15 });

    expect(brief.components.some((c) => c.name === 'waiting')).toBe(false);
    // 10 billable minutes × ₦20 = ₦200, then the motorcycle multiplier.
    expect(long.deliveryPay).toBeGreaterThan(brief.deliveryPay);
    expect(long.components.find((c) => c.name === 'waiting')?.amount).toBe(naira(200));
  });

  it('pays more for a vehicle that costs more to run', () => {
    const byVehicle = (['bicycle', 'motorcycle', 'car', 'van'] as const).map(
      (vehicleType) => computeRiderPay({ ...BASE, vehicleType }).deliveryPay,
    );
    // Strictly increasing.
    for (let i = 1; i < byVehicle.length; i += 1) {
      expect(byVehicle[i]!).toBeGreaterThan(byVehicle[i - 1]!);
    }
  });

  it('shares surge with the rider rather than keeping all of it', () => {
    const normal = computeRiderPay(BASE);
    const surged = computeRiderPay({ ...BASE, surgeMultiplier: 1.5 });

    expect(surged.deliveryPay).toBeGreaterThan(normal.deliveryPay);
    // The rider gets 70% of the uplift, so their pay rises by less than 1.5×.
    expect(surged.deliveryPay).toBeLessThan(normal.deliveryPay * 1.5);
    expect(surged.components.some((c) => c.name === 'surge')).toBe(true);
  });

  it('passes the tip through untouched and keeps it out of delivery pay', () => {
    const withTip = computeRiderPay({ ...BASE, tip: naira(1000) });
    const withoutTip = computeRiderPay(BASE);

    expect(withTip.tip).toBe(naira(1000));
    // The platform takes nothing from tips, and a tip never changes the
    // delivery pay it is added to.
    expect(withTip.deliveryPay).toBe(withoutTip.deliveryPay);
    expect(withTip.total).toBe(withoutTip.deliveryPay + naira(1000));
  });

  it('rejects impossible inputs rather than paying a nonsense amount', () => {
    expect(() => computeRiderPay({ ...BASE, tripMetres: -1 })).toThrow();
    expect(() => computeRiderPay({ ...BASE, approachMetres: Number.NaN })).toThrow();
    expect(() => computeRiderPay({ ...BASE, surgeMultiplier: 0.5 })).toThrow();
  });

  it('is deterministic', () => {
    const input = { ...BASE, tripMetres: 7350, surgeMultiplier: 1.35, tip: naira(250) };
    expect(JSON.stringify(computeRiderPay(input))).toBe(JSON.stringify(computeRiderPay(input)));
  });

  it('holds its invariants across randomised trips', () => {
    for (let i = 0; i < 300; i += 1) {
      const result = computeRiderPay({
        ...BASE,
        tripMetres: Math.random() * 30_000,
        approachMetres: Math.random() * 10_000,
        waitingMinutes: Math.random() * 40,
        surgeMultiplier: 1 + Math.random(),
        tip: kobo(Math.floor(Math.random() * 100_000)),
      });

      expect(sumComponents(result)).toBe(result.total);
      expect(result.deliveryPay).toBeGreaterThanOrEqual(DEFAULT_RIDER_PAY_RULES.minimumPay);
      expect(result.deliveryPay).toBeLessThanOrEqual(DEFAULT_RIDER_PAY_RULES.maximumPay);
      expect(Number.isSafeInteger(result.total)).toBe(true);
    }
  });
});
