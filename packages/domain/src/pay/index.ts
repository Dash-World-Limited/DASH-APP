/**
 * Rider pay.
 *
 * Deterministic and explained, like pricing and dispatch (ADR-0007). A rider
 * disputing what they were paid for a trip must be able to see every term.
 *
 * The guiding principle: **a rider is never paid less than the minimum for a
 * completed delivery, whatever the distance formula produces.** A 300m delivery
 * still costs the rider time, fuel, and risk, and the floor is what makes short
 * trips worth accepting rather than something to be gamed around.
 *
 * Rider pay is NOT the customer's delivery fee. The two are set independently:
 * the fee is what the market bears, the pay is what the work is worth. Coupling
 * them would mean a surge discount silently cutting rider earnings.
 */

import { add, clamp, kobo, multiply, percentOf, type Kobo } from '../money/index.js';
import type { VehicleType } from '../dispatch/index.js';

export const RIDER_PAY_RULE_VERSION = '2026.08.1';

export interface RiderPayRules {
  /** Paid on every completed delivery, before distance or time. */
  readonly basePay: Kobo;
  /** Per kilometre of the pickup-to-dropoff leg. */
  readonly perKilometre: Kobo;
  /** Per kilometre travelled to reach the pickup — otherwise long approaches are unpaid. */
  readonly perKilometreToPickup: Kobo;
  /** Per minute spent waiting at the vendor beyond the free allowance. */
  readonly perMinuteWaiting: Kobo;
  /** Waiting is free for this long; beyond it the vendor's delay is compensated. */
  readonly freeWaitingMinutes: number;
  /** No completed delivery pays less than this, ever. */
  readonly minimumPay: Kobo;
  /** Upper bound, so a GPS glitch cannot produce a five-figure payout. */
  readonly maximumPay: Kobo;
  /** Uplift in basis points during surge, shared with the rider. */
  readonly surgeShareBasisPoints: number;
}

export const DEFAULT_RIDER_PAY_RULES: RiderPayRules = {
  basePay: kobo(30_000), // ₦300
  perKilometre: kobo(8_000), // ₦80/km
  perKilometreToPickup: kobo(4_000), // ₦40/km — half rate, no cargo
  perMinuteWaiting: kobo(2_000), // ₦20/min
  freeWaitingMinutes: 5,
  minimumPay: kobo(40_000), // ₦400
  maximumPay: kobo(1_000_000), // ₦10,000
  surgeShareBasisPoints: 7_000, // riders get 70% of the surge uplift
};

/** Vehicles cost different amounts to run, so they earn different rates. */
const VEHICLE_MULTIPLIER: Readonly<Record<VehicleType, number>> = {
  on_foot: 0.9,
  bicycle: 1.0,
  motorcycle: 1.15,
  car: 1.4,
  van: 1.7,
};

export interface RiderPayComponent {
  readonly name:
    | 'base'
    | 'distance'
    | 'approach'
    | 'waiting'
    | 'vehicle'
    | 'surge'
    | 'minimum_top_up'
    | 'tip';
  readonly amount: Kobo;
  /** Shown verbatim in the rider's earnings breakdown. */
  readonly explanation: string;
}

export interface RiderPayResult {
  readonly ruleVersion: string;
  /** Everything except the tip — this is what the platform owes. */
  readonly deliveryPay: Kobo;
  /** The tip, passed through untouched. */
  readonly tip: Kobo;
  readonly total: Kobo;
  readonly components: readonly RiderPayComponent[];
}

export interface RiderPayInput {
  readonly rules: RiderPayRules;
  readonly vehicleType: VehicleType;
  /** Pickup to dropoff. */
  readonly tripMetres: number;
  /** Rider's start point to the pickup. */
  readonly approachMetres: number;
  /** Minutes the rider waited at the vendor. */
  readonly waitingMinutes: number;
  /** Zone surge in effect when the order was placed. 1 = none. */
  readonly surgeMultiplier: number;
  /** Customer tip, paid through in full. */
  readonly tip: Kobo;
}

/**
 * Compute what a rider is owed for one completed delivery.
 *
 * Order of operations:
 *   base → distance → approach → waiting → vehicle multiplier → surge share
 *   → minimum floor → cap → tip
 *
 * The vehicle multiplier applies to the whole earned amount rather than only to
 * distance, because running costs scale with the job, not just the kilometres.
 */
export function computeRiderPay(input: RiderPayInput): RiderPayResult {
  const { rules } = input;

  if (!Number.isFinite(input.tripMetres) || input.tripMetres < 0) {
    throw new Error(`Invalid trip distance ${input.tripMetres}`);
  }
  if (!Number.isFinite(input.approachMetres) || input.approachMetres < 0) {
    throw new Error(`Invalid approach distance ${input.approachMetres}`);
  }
  if (!Number.isFinite(input.surgeMultiplier) || input.surgeMultiplier < 1) {
    throw new Error(`Invalid surge multiplier ${input.surgeMultiplier}`);
  }

  const components: RiderPayComponent[] = [];

  components.push({
    name: 'base',
    amount: rules.basePay,
    explanation: 'Base pay for completing the delivery.',
  });

  const distancePay = multiply(rules.perKilometre, input.tripMetres / 1000);
  components.push({
    name: 'distance',
    amount: distancePay,
    explanation: `${(input.tripMetres / 1000).toFixed(1)}km from pickup to drop-off.`,
  });

  const approachPay = multiply(rules.perKilometreToPickup, input.approachMetres / 1000);
  components.push({
    name: 'approach',
    amount: approachPay,
    explanation: `${(input.approachMetres / 1000).toFixed(1)}km travelled to reach the vendor.`,
  });

  // Waiting beyond the free window is the vendor's delay, not the rider's, so
  // the rider is compensated for it.
  const billableWait = Math.max(0, input.waitingMinutes - rules.freeWaitingMinutes);
  const waitingPay = multiply(rules.perMinuteWaiting, billableWait);
  if (waitingPay > 0) {
    components.push({
      name: 'waiting',
      amount: waitingPay,
      explanation: `${Math.round(billableWait)} min waiting at the vendor beyond the free ${rules.freeWaitingMinutes} min.`,
    });
  }

  const earnedBeforeVehicle = add(rules.basePay, distancePay, approachPay, waitingPay);

  const multiplier = VEHICLE_MULTIPLIER[input.vehicleType];
  const vehicleUplift = kobo(multiply(earnedBeforeVehicle, multiplier) - earnedBeforeVehicle);
  if (vehicleUplift !== 0) {
    components.push({
      name: 'vehicle',
      amount: vehicleUplift,
      explanation: `Adjustment for running a ${input.vehicleType.replace('_', ' ')}.`,
    });
  }

  const afterVehicle = add(earnedBeforeVehicle, vehicleUplift);

  // Riders share in surge. If demand pricing raises what the customer pays, the
  // person doing the extra work in the rain sees most of it.
  let surgePay = kobo(0);
  if (input.surgeMultiplier > 1) {
    const fullUplift = kobo(multiply(afterVehicle, input.surgeMultiplier) - afterVehicle);
    surgePay = percentOf(fullUplift, rules.surgeShareBasisPoints);
    if (surgePay > 0) {
      components.push({
        name: 'surge',
        amount: surgePay,
        explanation: `Busy-period uplift at ${input.surgeMultiplier.toFixed(2)}×.`,
      });
    }
  }

  const beforeFloor = add(afterVehicle, surgePay);

  // The floor. A short trip still costs time, fuel, and risk.
  let deliveryPay = beforeFloor;
  if (beforeFloor < rules.minimumPay) {
    const topUp = kobo(rules.minimumPay - beforeFloor);
    components.push({
      name: 'minimum_top_up',
      amount: topUp,
      explanation: 'Topped up to the minimum paid for any completed delivery.',
    });
    deliveryPay = rules.minimumPay;
  }

  deliveryPay = clamp(deliveryPay, rules.minimumPay, rules.maximumPay);

  if (input.tip > 0) {
    components.push({
      name: 'tip',
      amount: input.tip,
      explanation: 'Customer tip, paid to you in full.',
    });
  }

  return {
    ruleVersion: RIDER_PAY_RULE_VERSION,
    deliveryPay,
    tip: input.tip,
    total: add(deliveryPay, input.tip),
    components,
  };
}
