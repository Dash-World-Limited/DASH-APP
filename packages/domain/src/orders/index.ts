/**
 * Order lifecycle.
 *
 * A single explicit state machine. Every transition names who is allowed to make
 * it, so "can a vendor cancel a delivered order?" has one answer in one file
 * rather than being re-litigated in each route.
 *
 * The machine is pure: it decides whether a transition is legal and what the
 * next state is. Persisting the change, writing the audit event, and emitting
 * the websocket notification are the caller's job.
 */

export const ORDER_STATUSES = [
  /** Basket being built. Not yet an order anyone else can see. */
  'draft',
  /** Payment authorization in flight. Held here until the provider answers. */
  'payment_pending',
  /** Paid/authorized and queued for the vendor. */
  'placed',
  /** Vendor has opened it but not yet decided. */
  'vendor_reviewing',
  /** Vendor committed to fulfil. */
  'accepted',
  'preparing',
  /** Food is up; waiting on a rider. */
  'ready',
  'rider_assigned',
  'rider_arrived',
  'picked_up',
  'en_route',
  /** Rider is at the customer, before handover completes. */
  'arrived',
  'delivered',
  'cancelled',
  /** Vendor declined. Distinct from cancelled — different refund and metrics. */
  'rejected',
  'refunded',
  'disputed',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Who initiated a transition. Determines which transitions are permitted. */
export type TransitionActor = 'customer' | 'vendor' | 'rider' | 'ops' | 'system';

/** Terminal states. Nothing leaves these except via a dispute or refund. */
export const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'refunded',
  'disputed',
]);

/** States where the customer's money has been taken and is at risk. */
export const PAID_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'placed',
  'vendor_reviewing',
  'accepted',
  'preparing',
  'ready',
  'rider_assigned',
  'rider_arrived',
  'picked_up',
  'en_route',
  'arrived',
  'delivered',
]);

/** States in which the order is live work for operations. */
export const ACTIVE_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'placed',
  'vendor_reviewing',
  'accepted',
  'preparing',
  'ready',
  'rider_assigned',
  'rider_arrived',
  'picked_up',
  'en_route',
  'arrived',
]);

/** States where a rider is holding the order. */
export const RIDER_HOLDING_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'picked_up',
  'en_route',
  'arrived',
]);

/**
 * States where an assigned rider is working the order: on the way to the
 * vendor, waiting at the counter, or bringing it to the customer. Accepting an
 * offer sets the rider and `rider_assigned` in one write, so in these states
 * the order's rider is the one the customer can reach. Before them nobody is
 * assigned; after them the job is over.
 */
export const RIDER_ON_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'rider_assigned',
  'rider_arrived',
  ...RIDER_HOLDING_STATUSES,
]);

interface TransitionRule {
  readonly to: OrderStatus;
  /** Actors permitted to make this transition unaided. */
  readonly actors: readonly TransitionActor[];
}

/**
 * The transition table.
 *
 * `ops` appears on nearly every rule because operations must be able to unstick
 * a real order at 9pm on a Friday. Every ops transition is audit-logged with a
 * mandatory reason code — the escape hatch is wide, but never silent.
 *
 * `customer` appears on `cancelled` for every state where
 * `evaluateCustomerCancellation()` reports `allowed: true`, and nowhere else.
 * These two must agree: the policy is what the API tells the customer and what
 * the web app renders its cancel button from, and this table is what actually
 * happens. When they disagreed, the button was always there and always failed.
 * `orders.test.ts` asserts the equivalence across every status.
 */
const TRANSITIONS: Readonly<Record<OrderStatus, readonly TransitionRule[]>> = {
  draft: [
    { to: 'payment_pending', actors: ['customer'] },
    { to: 'cancelled', actors: ['customer', 'system'] },
  ],
  payment_pending: [
    // `system` only: this is driven by the payment provider webhook, never by a
    // client asserting that it paid.
    { to: 'placed', actors: ['system'] },
    { to: 'draft', actors: ['system'] }, // payment failed, basket returned
    { to: 'cancelled', actors: ['customer', 'ops', 'system'] },
  ],
  placed: [
    { to: 'vendor_reviewing', actors: ['vendor', 'system'] },
    { to: 'accepted', actors: ['vendor', 'ops', 'system'] }, // system = auto-accept
    { to: 'rejected', actors: ['vendor', 'ops'] },
    { to: 'cancelled', actors: ['customer', 'ops', 'system'] },
  ],
  vendor_reviewing: [
    { to: 'accepted', actors: ['vendor', 'ops'] },
    { to: 'rejected', actors: ['vendor', 'ops'] },
    { to: 'cancelled', actors: ['customer', 'ops', 'system'] },
  ],
  accepted: [
    { to: 'preparing', actors: ['vendor', 'ops'] },
    // Dispatch can find a rider while the kitchen is still cooking.
    { to: 'rider_assigned', actors: ['ops', 'system'] },
    { to: 'cancelled', actors: ['customer', 'ops', 'system'] },
    { to: 'rejected', actors: ['vendor', 'ops'] },
  ],
  preparing: [
    { to: 'ready', actors: ['vendor', 'ops'] },
    { to: 'rider_assigned', actors: ['ops', 'system'] },
    // The customer may still cancel here, paying the fee that
    // `evaluateCustomerCancellation` charges to cover the vendor.
    { to: 'cancelled', actors: ['customer', 'ops'] },
  ],
  ready: [
    { to: 'rider_assigned', actors: ['ops', 'system'] },
    { to: 'rider_arrived', actors: ['rider', 'ops', 'system'] },
    { to: 'picked_up', actors: ['rider', 'ops'] }, // customer-pickup orders
    { to: 'cancelled', actors: ['customer', 'ops'] },
  ],
  rider_assigned: [
    { to: 'rider_arrived', actors: ['rider', 'ops', 'system'] },
    // Reassignment drops back to `ready` and re-enters dispatch.
    { to: 'ready', actors: ['ops', 'system'] },
    { to: 'cancelled', actors: ['customer', 'ops'] },
  ],
  rider_arrived: [
    { to: 'picked_up', actors: ['rider', 'ops'] },
    { to: 'ready', actors: ['ops', 'system'] },
    // The last point a customer may cancel. From `picked_up` onward the rider
    // is carrying the food and the policy refuses.
    { to: 'cancelled', actors: ['customer', 'ops'] },
  ],
  picked_up: [
    { to: 'en_route', actors: ['rider', 'ops', 'system'] },
    { to: 'cancelled', actors: ['ops'] },
  ],
  en_route: [
    { to: 'arrived', actors: ['rider', 'ops', 'system'] },
    { to: 'delivered', actors: ['rider', 'ops'] },
    { to: 'cancelled', actors: ['ops'] },
  ],
  arrived: [
    { to: 'delivered', actors: ['rider', 'ops'] },
    { to: 'cancelled', actors: ['ops'] },
  ],
  delivered: [
    { to: 'disputed', actors: ['customer', 'ops'] },
    { to: 'refunded', actors: ['ops'] },
  ],
  cancelled: [{ to: 'refunded', actors: ['ops', 'system'] }],
  rejected: [{ to: 'refunded', actors: ['ops', 'system'] }],
  refunded: [{ to: 'disputed', actors: ['customer', 'ops'] }],
  disputed: [{ to: 'refunded', actors: ['ops'] }],
};

export class OrderTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
    readonly actor: TransitionActor,
    message: string,
  ) {
    super(message);
    this.name = 'OrderTransitionError';
  }
}

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

/** Every state reachable from `from` by anyone. */
export function allowedTransitions(from: OrderStatus): readonly OrderStatus[] {
  return (TRANSITIONS[from] ?? []).map((rule) => rule.to);
}

/** States reachable from `from` by this specific actor. Drives UI buttons. */
export function allowedTransitionsFor(
  from: OrderStatus,
  actor: TransitionActor,
): readonly OrderStatus[] {
  return (TRANSITIONS[from] ?? [])
    .filter((rule) => rule.actors.includes(actor))
    .map((rule) => rule.to);
}

export function canTransition(
  from: OrderStatus,
  to: OrderStatus,
  actor: TransitionActor,
): boolean {
  return (TRANSITIONS[from] ?? []).some(
    (rule) => rule.to === to && rule.actors.includes(actor),
  );
}

/**
 * Gate a transition. Throws on an illegal move.
 *
 * Note that a same-state "transition" is rejected rather than treated as a
 * no-op: a duplicate `mark ready` tap should be caught by idempotency at the
 * route, not silently absorbed here where it would hide a real bug.
 */
export function assertTransition(
  from: OrderStatus,
  to: OrderStatus,
  actor: TransitionActor,
): void {
  if (from === to) {
    throw new OrderTransitionError(from, to, actor, `Order is already ${from}.`);
  }
  if (!canTransition(from, to, actor)) {
    const legal = allowedTransitionsFor(from, actor);
    throw new OrderTransitionError(
      from,
      to,
      actor,
      legal.length === 0
        ? `A ${actor} cannot change an order that is ${from}.`
        : `Cannot move an order from ${from} to ${to}. Allowed: ${legal.join(', ')}.`,
    );
  }
}

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isActive(status: OrderStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function isPaid(status: OrderStatus): boolean {
  return PAID_STATUSES.has(status);
}

export function isRiderOnOrder(status: OrderStatus): boolean {
  return RIDER_ON_ORDER_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// Rating the rider
// ---------------------------------------------------------------------------

export const RIDER_RATING_MIN = 1;
export const RIDER_RATING_MAX = 5;
export const RIDER_RATING_COMMENT_MAX = 500;

export type RiderRatingRefusal = 'not_delivered' | 'no_rider' | 'already_rated';

/**
 * Whether the customer may rate this order's rider now: only once the order
 * has really been delivered, only if a rider delivered it, and only once.
 * Returns why not, or null when a rating is allowed.
 */
export function riderRatingRefusal(
  order: { status: OrderStatus; riderId: string | null; deliveredAt: Date | string | null },
  alreadyRated: boolean,
): RiderRatingRefusal | null {
  if (order.status !== 'delivered' || !order.deliveredAt) return 'not_delivered';
  if (!order.riderId) return 'no_rider';
  if (alreadyRated) return 'already_rated';
  return null;
}

export function describeRiderRatingRefusal(refusal: RiderRatingRefusal): string {
  switch (refusal) {
    case 'not_delivered':
      return 'You can rate your rider once this order has been delivered.';
    case 'no_rider':
      return 'No DASH rider delivered this order, so there is no rider to rate.';
    case 'already_rated':
      return 'You have already rated the rider for this order.';
  }
}

// ---------------------------------------------------------------------------
// Cancellation policy
// ---------------------------------------------------------------------------

/**
 * What a customer is charged for cancelling, expressed in basis points of the
 * order subtotal. The principle: the customer bears cost only once someone else
 * has incurred cost on their behalf.
 */
export interface CancellationOutcome {
  readonly allowed: boolean;
  /** Fee as basis points of subtotal. 0 = free. */
  readonly feeBasisPoints: number;
  /** Portion of the paid total to return, in basis points. */
  readonly refundBasisPoints: number;
  /** Shown to the customer before they confirm. */
  readonly explanation: string;
  readonly reasonCode: CancellationReasonCode;
}

export type CancellationReasonCode =
  | 'free_before_vendor_accepts'
  | 'fee_after_preparation_started'
  | 'no_refund_after_pickup'
  | 'not_cancellable'
  | 'vendor_rejected'
  | 'ops_override';

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

/**
 * The states a `Refund` row can be in.
 *
 * V1 moves no money back automatically. A refund that is owed is recorded as
 * `refund_pending_manual_review`; the DASH team returns it through Paystack
 * and it becomes `refunded` only once Paystack confirms the refund exists
 * and has been processed. Nothing — no screen, no email, no API answer —
 * says "refunded" before that.
 *
 * `refund_processing` is a refund Paystack has accepted and not yet finished:
 * linked to a real Paystack refund, but the money is not back yet.
 */
export const REFUND_STATES = [
  'refund_pending_manual_review',
  'refund_processing',
  'refunded',
  'refund_failed',
] as const;
export type RefundState = (typeof REFUND_STATES)[number];

/**
 * States from which a refund may be linked to the provider's refund and
 * checked. `pending` is the table default, kept for rows written before the
 * states above existed. `refund_failed` is included so a second attempt made
 * at Paystack can be linked after the first one failed.
 */
const CONFIRMABLE_REFUND_STATES: ReadonlySet<string> = new Set([
  'pending',
  'refund_pending_manual_review',
  'refund_processing',
  'refund_failed',
]);

/** What the payment provider says about one refund, in provider-neutral terms. */
export interface ProviderRefundFacts {
  /** The refund exists at the provider and was made against this payment's transaction. */
  readonly matchesPayment: boolean;
  /** `processed` is the only state meaning the money has gone back. */
  readonly status: 'processed' | 'pending' | 'failed';
  /** Integer kobo. */
  readonly amount: number;
  readonly currency: string;
}

export type RefundConfirmation =
  | { readonly kind: 'move'; readonly to: 'refunded' | 'refund_processing' | 'refund_failed' }
  | {
      readonly kind: 'refuse';
      readonly reason: 'not_confirmable' | 'not_this_payment' | 'currency_mismatch' | 'amount_mismatch';
    };

/**
 * Whether the provider's account of a refund lets our refund move, and where to.
 *
 * The only road to `refunded` runs through here, and it needs the provider to
 * say three things at once: this refund is against *our* transaction, for
 * *exactly* the amount we recorded (and booked in the ledger), and it has been
 * processed. A person cannot declare a refund done; they can only point at the
 * provider's refund and let the provider answer.
 *
 * An amount that differs is refused rather than accepted as partial. The
 * ledger was booked for the recorded amount when the refund was approved, and
 * silently accepting a different figure would leave the books and the bank
 * disagreeing with nobody told.
 */
export function decideRefundConfirmation(
  current: { readonly status: string; readonly amount: number },
  facts: ProviderRefundFacts,
): RefundConfirmation {
  if (!CONFIRMABLE_REFUND_STATES.has(current.status)) return { kind: 'refuse', reason: 'not_confirmable' };
  if (!facts.matchesPayment) return { kind: 'refuse', reason: 'not_this_payment' };
  if (facts.currency !== 'NGN') return { kind: 'refuse', reason: 'currency_mismatch' };
  if (!Number.isInteger(facts.amount) || facts.amount !== current.amount) {
    return { kind: 'refuse', reason: 'amount_mismatch' };
  }

  switch (facts.status) {
    case 'processed':
      return { kind: 'move', to: 'refunded' };
    case 'failed':
      return { kind: 'move', to: 'refund_failed' };
    default:
      return { kind: 'move', to: 'refund_processing' };
  }
}

/**
 * An owed refund not returned at the provider within this long is waiting on
 * a person. Refunds are made by hand in the Paystack dashboard, so a deadline
 * is the only thing that notices one nobody made.
 */
export const REFUND_OVERDUE_MS = 48 * 60 * 60_000;

/** Owed, and not yet returned at the provider (`pending` is the older default). */
export const OWED_REFUND_STATES: readonly string[] = ['pending', 'refund_pending_manual_review'];

/** Paystack's word for a refund it cannot finish until someone acts in its dashboard. */
export const PROVIDER_REFUND_NEEDS_ATTENTION: readonly string[] = ['needs-attention', 'needs_attention'];

/** Why a refund is waiting on a person, if it is. */
export type RefundAwaitingPerson = 'overdue' | 'failed' | 'needs_attention';

/**
 * Whether a refund needs a person to act now, and why:
 *
 *   - `overdue` — owed for longer than `REFUND_OVERDUE_MS` and nobody has
 *     returned it at the provider yet;
 *   - `failed` — the provider reported the refund failed; the customer is
 *     still owed, and a new refund has to be issued and linked;
 *   - `needs_attention` — linked, but the provider cannot finish it until
 *     someone acts in its dashboard.
 *
 * The maintenance job reports these on every run until they clear, and the
 * finance console marks them. Neither changes the refund.
 */
export function refundAwaitingPerson(
  refund: { readonly status: string; readonly providerStatus: string | null; readonly createdAt: Date },
  now: Date,
): RefundAwaitingPerson | null {
  if (refund.status === 'refund_failed') return 'failed';
  if (refund.status === 'refund_processing' && refund.providerStatus !== null) {
    return PROVIDER_REFUND_NEEDS_ATTENTION.includes(refund.providerStatus) ? 'needs_attention' : null;
  }
  if (OWED_REFUND_STATES.includes(refund.status) && now.getTime() - refund.createdAt.getTime() > REFUND_OVERDUE_MS) {
    return 'overdue';
  }
  return null;
}

/** What the customer is told about how a refund reaches them. */
export const REFUND_PROCESS =
  'Refunds are checked by the DASH team and returned to your card through Paystack. We will tell you when it has been returned.';

/** The customer-facing sentence for a refund's current state. */
export function describeRefund(state: string): { label: string; body: string } {
  switch (state) {
    case 'refunded':
      return { label: 'Refunded', body: 'Paystack has confirmed this refund to your card. Banks can take a few days to show it.' };
    case 'refund_processing':
      return {
        label: 'Refund on its way',
        body: 'Paystack has accepted this refund and is processing it. It will show as refunded here once Paystack confirms it.',
      };
    case 'refund_failed':
      return { label: 'Refund needs attention', body: 'This refund could not be completed. The DASH team will contact you.' };
    default:
      // `refund_pending_manual_review`, and the older `pending` rows.
      return { label: 'Refund pending review', body: REFUND_PROCESS };
  }
}

/**
 * Customer-initiated cancellation policy.
 *
 * Deliberately generous before `preparing`: the vendor has spent nothing, and
 * charging for a change of mind in the first 90 seconds is the fastest way to
 * lose a customer. Once food is being cooked, the vendor is compensated.
 */
export function evaluateCustomerCancellation(status: OrderStatus): CancellationOutcome {
  switch (status) {
    case 'draft':
      return {
        allowed: true,
        feeBasisPoints: 0,
        refundBasisPoints: 0,
        explanation: 'Nothing has been charged yet.',
        reasonCode: 'free_before_vendor_accepts',
      };

    case 'payment_pending':
      // Payment has not been confirmed. Should a charge land after all, the
      // whole of it is owed back — the basis points say so — but the customer
      // is told what is true now.
      return {
        allowed: true,
        feeBasisPoints: 0,
        refundBasisPoints: 10_000,
        explanation: 'Your payment has not been confirmed, so nothing has been charged.',
        reasonCode: 'free_before_vendor_accepts',
      };

    case 'placed':
    case 'vendor_reviewing':
    case 'accepted':
      return {
        allowed: true,
        feeBasisPoints: 0,
        refundBasisPoints: 10_000,
        explanation: `Your order has not been prepared yet, so the full amount is owed back to you. ${REFUND_PROCESS}`,
        reasonCode: 'free_before_vendor_accepts',
      };

    case 'preparing':
    case 'ready':
    case 'rider_assigned':
    case 'rider_arrived':
      return {
        allowed: true,
        feeBasisPoints: 3_000, // 30% — covers vendor ingredient and labour cost
        refundBasisPoints: 7_000,
        explanation: `Your order is already being prepared. A 30% charge covers the vendor, and the rest is owed back to you. ${REFUND_PROCESS}`,
        reasonCode: 'fee_after_preparation_started',
      };

    case 'picked_up':
    case 'en_route':
    case 'arrived':
      return {
        allowed: false,
        feeBasisPoints: 10_000,
        refundBasisPoints: 0,
        explanation:
          'Your order is already on its way. Contact support if something is wrong with it.',
        reasonCode: 'no_refund_after_pickup',
      };

    case 'delivered':
    case 'cancelled':
    case 'rejected':
    case 'refunded':
    case 'disputed':
      return {
        allowed: false,
        feeBasisPoints: 0,
        refundBasisPoints: 0,
        explanation: 'This order can no longer be cancelled.',
        reasonCode: 'not_cancellable',
      };
  }
}

/**
 * When a vendor rejects, the customer is never at fault and is always made whole
 * — including the delivery fee they had already paid.
 */
export function vendorRejectionOutcome(): CancellationOutcome {
  return {
    allowed: true,
    feeBasisPoints: 0,
    refundBasisPoints: 10_000,
    explanation: 'The vendor could not take this order. You have been fully refunded.',
    reasonCode: 'vendor_rejected',
  };
}

// ---------------------------------------------------------------------------
// Progress, for customer-facing timelines
// ---------------------------------------------------------------------------

/**
 * Coarse phase for the tracking UI. Several statuses collapse into one phase so
 * the customer sees a four-step timeline rather than a fifteen-step one.
 */
export type OrderPhase = 'confirming' | 'preparing' | 'on_the_way' | 'complete' | 'stopped';

export function phaseOf(status: OrderStatus): OrderPhase {
  switch (status) {
    case 'draft':
    case 'payment_pending':
    case 'placed':
    case 'vendor_reviewing':
      return 'confirming';
    case 'accepted':
    case 'preparing':
    case 'ready':
    case 'rider_assigned':
    case 'rider_arrived':
      return 'preparing';
    case 'picked_up':
    case 'en_route':
    case 'arrived':
      return 'on_the_way';
    case 'delivered':
      return 'complete';
    case 'cancelled':
    case 'rejected':
    case 'refunded':
    case 'disputed':
      return 'stopped';
  }
}

/**
 * Order vocabulary, per section.
 *
 * `customerLabel` moved to vocabulary.ts when it became vertical-aware: one
 * state machine, five ways of describing the same work. Re-exported here so the
 * import site does not have to know which file the words live in.
 */
export {
  customerLabel,
  customerTimeline,
  vendorStartActionLabel,
  vendorStatusLabel,
  verticalOf,
  type Vertical,
  type VendorCategory,
} from './vocabulary.js';

