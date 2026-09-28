import { describe, expect, it } from 'vitest';
import {
  allowedTransitionsFor,
  assertTransition,
  canTransition,
  customerLabel,
  decideRefundConfirmation,
  describeRefund,
  evaluateCustomerCancellation,
  isActive,
  isPaid,
  isTerminal,
  ORDER_STATUSES,
  OrderTransitionError,
  phaseOf,
  REFUND_OVERDUE_MS,
  REFUND_STATES,
  refundAwaitingPerson,
  vendorRejectionOutcome,
  type OrderStatus,
  type TransitionActor,
} from './index.js';

const ACTORS: readonly TransitionActor[] = ['customer', 'vendor', 'rider', 'ops', 'system'];

describe('state machine integrity', () => {
  it('gives every status a label, a phase, and a defined transition set', () => {
    for (const status of ORDER_STATUSES) {
      expect(customerLabel(status)).toBeTruthy();
      expect(phaseOf(status)).toBeTruthy();
      expect(Array.isArray(allowedTransitionsFor(status, 'ops'))).toBe(true);
    }
  });

  it('never allows a self-transition', () => {
    for (const status of ORDER_STATUSES) {
      for (const actor of ACTORS) {
        expect(canTransition(status, status, actor)).toBe(false);
      }
    }
  });

  it('only ever transitions to a real status', () => {
    for (const status of ORDER_STATUSES) {
      for (const actor of ACTORS) {
        for (const next of allowedTransitionsFor(status, actor)) {
          expect(ORDER_STATUSES).toContain(next);
        }
      }
    }
  });

  it('leaves no status unreachable except the initial draft', () => {
    const reachable = new Set<OrderStatus>();
    for (const status of ORDER_STATUSES) {
      for (const actor of ACTORS) {
        for (const next of allowedTransitionsFor(status, actor)) reachable.add(next);
      }
    }
    for (const status of ORDER_STATUSES) {
      if (status === 'draft') continue;
      expect(reachable.has(status), `${status} is unreachable`).toBe(true);
    }
  });

  it('lets operations act on every live order — the 9pm Friday escape hatch', () => {
    for (const status of ORDER_STATUSES) {
      if (isTerminal(status)) continue;
      // `draft` is deliberately excluded: an unsubmitted basket is the
      // customer's private workspace, and ops has no business reaching into it.
      // The escape hatch starts the moment an order becomes shared work.
      if (status === 'draft') continue;
      expect(
        allowedTransitionsFor(status, 'ops').length,
        `ops is stuck at ${status}`,
      ).toBeGreaterThan(0);
    }
  });

  it('keeps operations out of a customer’s unsubmitted basket', () => {
    expect(allowedTransitionsFor('draft', 'ops')).toHaveLength(0);
    expect(allowedTransitionsFor('draft', 'vendor')).toHaveLength(0);
    expect(allowedTransitionsFor('draft', 'rider')).toHaveLength(0);
  });
});

describe('who may do what', () => {
  it('lets a vendor accept or reject a placed order', () => {
    expect(canTransition('placed', 'accepted', 'vendor')).toBe(true);
    expect(canTransition('placed', 'rejected', 'vendor')).toBe(true);
  });

  it('does not let a vendor cancel an order that is already with a rider', () => {
    expect(canTransition('picked_up', 'cancelled', 'vendor')).toBe(false);
    expect(canTransition('en_route', 'cancelled', 'vendor')).toBe(false);
  });

  it('does not let a customer mark their own order delivered', () => {
    expect(canTransition('en_route', 'delivered', 'customer')).toBe(false);
    expect(canTransition('arrived', 'delivered', 'customer')).toBe(false);
  });

  it('does not let a rider accept an order on the vendor’s behalf', () => {
    expect(canTransition('placed', 'accepted', 'rider')).toBe(false);
  });

  it('only lets the system confirm payment — never a client claiming it paid', () => {
    expect(canTransition('payment_pending', 'placed', 'system')).toBe(true);
    expect(canTransition('payment_pending', 'placed', 'customer')).toBe(false);
    expect(canTransition('payment_pending', 'placed', 'vendor')).toBe(false);
    expect(canTransition('payment_pending', 'placed', 'rider')).toBe(false);
    // Not even ops — payment truth comes from the provider webhook alone.
    expect(canTransition('payment_pending', 'placed', 'ops')).toBe(false);
  });

  it('does not let a customer refund themselves', () => {
    expect(canTransition('delivered', 'refunded', 'customer')).toBe(false);
    expect(canTransition('cancelled', 'refunded', 'customer')).toBe(false);
  });

  it('lets a customer raise a dispute after delivery', () => {
    expect(canTransition('delivered', 'disputed', 'customer')).toBe(true);
  });

  it('allows reassignment back into the dispatch pool', () => {
    expect(canTransition('rider_assigned', 'ready', 'ops')).toBe(true);
    expect(canTransition('rider_arrived', 'ready', 'system')).toBe(true);
  });
});

describe('assertTransition', () => {
  it('permits a legal move', () => {
    expect(() => assertTransition('placed', 'accepted', 'vendor')).not.toThrow();
  });

  it('rejects an illegal move with a message naming the legal ones', () => {
    try {
      assertTransition('delivered', 'preparing', 'vendor');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(OrderTransitionError);
      expect((error as OrderTransitionError).from).toBe('delivered');
      expect((error as OrderTransitionError).to).toBe('preparing');
    }
  });

  it('rejects a repeated transition rather than absorbing it silently', () => {
    // A double-tap on "mark ready" must be caught by route idempotency, not
    // swallowed here where it would mask a real bug.
    expect(() => assertTransition('ready', 'ready', 'vendor')).toThrow(OrderTransitionError);
  });

  it('rejects skipping the middle of the delivery flow', () => {
    expect(() => assertTransition('accepted', 'delivered', 'rider')).toThrow(OrderTransitionError);
    expect(() => assertTransition('placed', 'picked_up', 'rider')).toThrow(OrderTransitionError);
  });
});

describe('status groupings', () => {
  it('classifies paid states', () => {
    expect(isPaid('placed')).toBe(true);
    expect(isPaid('delivered')).toBe(true);
    expect(isPaid('draft')).toBe(false);
    expect(isPaid('payment_pending')).toBe(false);
    expect(isPaid('cancelled')).toBe(false);
  });

  it('classifies active operational states', () => {
    expect(isActive('preparing')).toBe(true);
    expect(isActive('en_route')).toBe(true);
    expect(isActive('delivered')).toBe(false);
    expect(isActive('draft')).toBe(false);
  });

  it('classifies terminal states', () => {
    expect(isTerminal('refunded')).toBe(true);
    expect(isTerminal('disputed')).toBe(true);
    expect(isTerminal('delivered')).toBe(false);
  });
});

describe('phases', () => {
  it('collapses the machine into a four-step customer timeline', () => {
    expect(phaseOf('placed')).toBe('confirming');
    expect(phaseOf('preparing')).toBe('preparing');
    expect(phaseOf('rider_assigned')).toBe('preparing');
    expect(phaseOf('en_route')).toBe('on_the_way');
    expect(phaseOf('delivered')).toBe('complete');
    expect(phaseOf('cancelled')).toBe('stopped');
  });
});

describe('customer cancellation policy', () => {
  it('is free before the vendor starts cooking', () => {
    for (const status of ['placed', 'vendor_reviewing', 'accepted'] as const) {
      const outcome = evaluateCustomerCancellation(status);
      expect(outcome.allowed).toBe(true);
      expect(outcome.feeBasisPoints).toBe(0);
      expect(outcome.refundBasisPoints).toBe(10_000);
    }
  });

  it('charges once the vendor has incurred cost', () => {
    const outcome = evaluateCustomerCancellation('preparing');
    expect(outcome.allowed).toBe(true);
    expect(outcome.feeBasisPoints).toBe(3000);
    expect(outcome.refundBasisPoints).toBe(7000);
    expect(outcome.reasonCode).toBe('fee_after_preparation_started');
  });

  it('refuses once the food is with the rider', () => {
    for (const status of ['picked_up', 'en_route', 'arrived'] as const) {
      const outcome = evaluateCustomerCancellation(status);
      expect(outcome.allowed).toBe(false);
      expect(outcome.refundBasisPoints).toBe(0);
    }
  });

  it('always splits fee and refund to exactly 100%', () => {
    for (const status of ORDER_STATUSES) {
      const outcome = evaluateCustomerCancellation(status);
      if (!outcome.allowed || status === 'draft') continue;
      expect(outcome.feeBasisPoints + outcome.refundBasisPoints).toBe(10_000);
    }
  });

  it('always gives an explanation the customer can read', () => {
    for (const status of ORDER_STATUSES) {
      expect(evaluateCustomerCancellation(status).explanation.length).toBeGreaterThan(10);
    }
  });

  it('makes the customer whole when the vendor rejects', () => {
    const outcome = vendorRejectionOutcome();
    expect(outcome.refundBasisPoints).toBe(10_000);
    expect(outcome.feeBasisPoints).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('the cancellation policy and the state machine must agree', () => {
  /**
   * Two sources of truth describe the same thing, and nothing kept them in
   * sync.
   *
   * `evaluateCustomerCancellation()` decides what the customer is *told* — the
   * API returns it as `cancellation.allowed`, and the web app renders a "Cancel
   * this order" button from it. `canTransition(..., 'customer')` decides what
   * the customer can actually *do*.
   *
   * When they disagreed, the app showed a cancel button that always failed with
   * a 409. This test is the reason they cannot drift apart again.
   */
  it('allows a customer transition exactly when the policy says cancellation is allowed', () => {
    const mismatches: string[] = [];

    for (const status of ORDER_STATUSES) {
      const policyAllows = evaluateCustomerCancellation(status).allowed;
      const machineAllows = canTransition(status, 'cancelled', 'customer');

      if (policyAllows !== machineAllows) {
        mismatches.push(
          `${status}: policy says ${policyAllows}, state machine says ${machineAllows}`,
        );
      }
    }

    expect(mismatches, `\n  ${mismatches.join('\n  ')}\n`).toEqual([]);
  });

  it('lets the customer cancel while the vendor is still preparing', () => {
    // The specific case that surfaced the mismatch. The policy charges 30% to
    // cover the vendor's ingredients and labour, which only makes sense if the
    // cancellation can actually happen.
    expect(canTransition('preparing', 'cancelled', 'customer')).toBe(true);
    expect(evaluateCustomerCancellation('preparing').feeBasisPoints).toBe(3000);
  });

  it('refuses customer cancellation once the rider is carrying the food', () => {
    for (const status of ['picked_up', 'en_route', 'arrived'] as const) {
      expect(canTransition(status, 'cancelled', 'customer'), status).toBe(false);
      expect(evaluateCustomerCancellation(status).allowed, status).toBe(false);
    }
  });
});

describe('confirming a refund with the provider', () => {
  const owed = { status: 'refund_pending_manual_review', amount: 150_000 };
  const processed = { matchesPayment: true, status: 'processed', amount: 150_000, currency: 'NGN' } as const;

  it('moves to refunded only when the provider reports it processed, for this payment and amount', () => {
    expect(decideRefundConfirmation(owed, processed)).toEqual({ kind: 'move', to: 'refunded' });
    expect(decideRefundConfirmation(owed, { ...processed, status: 'pending' })).toEqual({
      kind: 'move',
      to: 'refund_processing',
    });
    expect(decideRefundConfirmation(owed, { ...processed, status: 'failed' })).toEqual({ kind: 'move', to: 'refund_failed' });
  });

  it('refuses a refund for another payment, another currency or another amount', () => {
    const refused = (reason: string) => ({ kind: 'refuse', reason });
    expect(decideRefundConfirmation(owed, { ...processed, matchesPayment: false })).toEqual(refused('not_this_payment'));
    expect(decideRefundConfirmation(owed, { ...processed, currency: 'USD' })).toEqual(refused('currency_mismatch'));
    for (const amount of [149_999, 300_000, 150_000.5, 0]) {
      expect(decideRefundConfirmation(owed, { ...processed, amount }), String(amount)).toEqual(refused('amount_mismatch'));
    }
  });

  it('can be checked from every open state, and from none that is closed', () => {
    for (const status of ['pending', 'refund_pending_manual_review', 'refund_processing', 'refund_failed']) {
      expect(decideRefundConfirmation({ ...owed, status }, processed).kind, status).toBe('move');
    }
    for (const status of ['refunded', 'failed', 'anything_else']) {
      expect(decideRefundConfirmation({ ...owed, status }, processed), status).toEqual({
        kind: 'refuse',
        reason: 'not_confirmable',
      });
    }
  });

  it('tells the customer "Refunded" only in the confirmed state', () => {
    for (const state of REFUND_STATES) {
      expect(describeRefund(state).label === 'Refunded', state).toBe(state === 'refunded');
    }
    expect(describeRefund('refund_processing').body).toMatch(/once Paystack confirms/);
  });
});

describe('a refund waiting on a person', () => {
  const now = new Date('2026-09-28T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const refund = (status: string, createdAt: Date, providerStatus: string | null = null) => ({ status, providerStatus, createdAt });

  it('is overdue once owed past the deadline and not yet returned at the provider', () => {
    for (const status of ['pending', 'refund_pending_manual_review']) {
      expect(refundAwaitingPerson(refund(status, ago(REFUND_OVERDUE_MS - 1)), now), status).toBeNull();
      expect(refundAwaitingPerson(refund(status, ago(REFUND_OVERDUE_MS + 1)), now), status).toBe('overdue');
    }
  });

  it('always needs a person once the provider has failed it, however recent', () => {
    expect(refundAwaitingPerson(refund('refund_failed', now, 'failed'), now)).toBe('failed');
  });

  it('needs a person when the provider marks it needs-attention, and not while it is simply processing', () => {
    const old = ago(10 * REFUND_OVERDUE_MS);
    expect(refundAwaitingPerson(refund('refund_processing', old, 'needs-attention'), now)).toBe('needs_attention');
    expect(refundAwaitingPerson(refund('refund_processing', old, 'processing'), now)).toBeNull();
    expect(refundAwaitingPerson(refund('refund_processing', old, 'pending'), now)).toBeNull();
  });

  it('never flags a refund that is done', () => {
    expect(refundAwaitingPerson(refund('refunded', ago(10 * REFUND_OVERDUE_MS), 'processed'), now)).toBeNull();
  });
});
