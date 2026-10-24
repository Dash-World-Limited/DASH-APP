/**
 * What each section calls the same logistics.
 *
 * One order state machine moves every DASH order, and it should: a sofa, a
 * prescription and a plate of jollof are collected and delivered by the same
 * rider under the same rules, and proving that machine took a fortnight of
 * physical testing. Nothing here touches it.
 *
 * What differs is the *sentence*. `preparing` is a kitchen word, and it was
 * being shown to someone buying a washing machine. So the status stays and the
 * language becomes vertical-aware — a presentation mapping, not a second state
 * machine.
 *
 * ## Why this is one module
 *
 * Before this, customer vocabulary lived in `customerLabel`, the tracking
 * timeline kept a second copy in a local array, and the vendor console printed
 * the raw status with the underscores swapped for spaces. Three vocabularies
 * for one set of states, already diverging. Every string a user reads about
 * order state now comes from here, so the eventual redesign restyles surfaces
 * without re-deriving words.
 *
 * ## What is deliberately *not* here
 *
 * Rider language. A rider's job is identical in all five sections — go to the
 * vendor, collect, deliver — and their screen says so. Vertical vocabulary on
 * an operational screen would be noise at best and confusing mid-shift at
 * worst.
 */

import type { OrderStatus } from './index.js';

/** What the vendor row stores. */
export type VendorCategory =
  | 'restaurant'
  | 'grocery'
  | 'pharmacy'
  | 'retail'
  | 'market'
  | 'declutter';

/**
 * What the customer thinks they are shopping in.
 *
 * Five sections, six categories: `grocery` and `retail` are both Shops to
 * someone doing their errands, while the backend keeps them apart because
 * commission, licensing and reporting differ. That grouping lives here and in
 * `lib/sections.ts`, and nowhere else.
 */
export type Vertical = 'restaurants' | 'shops' | 'pharmacy' | 'market' | 'declutter';

export function verticalOf(category: string | null | undefined): Vertical {
  switch (category) {
    case 'restaurant':
      return 'restaurants';
    case 'pharmacy':
      return 'pharmacy';
    case 'market':
      return 'market';
    case 'declutter':
      return 'declutter';
    case 'grocery':
    case 'retail':
      return 'shops';
    default:
      // An unknown or missing category reads as Shops: the most general
      // vocabulary, and never wrong in a way that misleads. Falling back to
      // restaurant language is how "Being prepared" reached a furniture buyer.
      return 'shops';
  }
}

/**
 * The one status whose name is genuinely vertical-specific.
 *
 * Everything before it is about agreement and everything after it is about
 * logistics; only this describes what the merchant is physically doing, and
 * that is different work in each section.
 *
 * Pharmacy says "Processing your order" and never "Preparing your medicine".
 * The second implies compounding — making up a preparation — which is a
 * regulated activity DASH does not perform and must not appear to.
 *
 * Declutter is a placeholder, and deliberately says nothing. Its real lifecycle
 * — listing, inspection, agreement, reservation, self-pickup — does not exist
 * yet, and language implying any of it would describe a flow the app cannot
 * carry out. "Processing your order" is the honest thing to say about a state
 * that is, for now, exactly that.
 */
const PREPARING: Record<Vertical, string> = {
  restaurants: 'Preparing your order',
  shops: 'Picking & packing',
  pharmacy: 'Processing your order',
  market: 'Sourcing your items',
  declutter: 'Processing your order',
};

/** Ready for the rider. "Packed" reads better wherever nothing was cooked. */
const READY: Record<Vertical, string> = {
  restaurants: 'Ready for pickup',
  shops: 'Packed and ready',
  pharmacy: 'Packed and ready',
  market: 'Packed and ready',
  declutter: 'Ready for pickup',
};

/** Short customer-facing label. Never exposes internal status names. */
export function customerLabel(status: OrderStatus, category?: string | null): string {
  const vertical = verticalOf(category);

  switch (status) {
    case 'draft':
      return 'Basket';
    case 'payment_pending':
      return 'Confirming payment';
    case 'placed':
      return 'Sent to vendor';
    case 'vendor_reviewing':
      return 'Vendor is reviewing';
    case 'accepted':
      return 'Order confirmed';
    case 'preparing':
      return PREPARING[vertical];
    case 'ready':
      return READY[vertical];
    // From here every section is the same job, so every section says the same
    // thing. Diverging below this line would be decoration, not information.
    case 'rider_assigned':
      return 'Rider on the way to collect';
    case 'rider_arrived':
      return 'Rider at the pickup point';
    case 'picked_up':
      return 'Picked up';
    case 'en_route':
      return 'On the way to you';
    case 'arrived':
      return 'Rider has arrived';
    case 'delivered':
      return 'Delivered';
    case 'cancelled':
      return 'Cancelled';
    case 'rejected':
      return 'Could not be fulfilled';
    case 'refunded':
      return 'Refunded';
    case 'disputed':
      return 'Under review';
  }
}

/**
 * What the merchant sees on their own board.
 *
 * Separate from the customer's wording because the audience is different: a
 * vendor needs the state of *their* work, not a reassurance. It exists at all
 * because the console was rendering `status.replace(/_/g, ' ')` — printing raw
 * internal names like "vendor reviewing" and "rider assigned" to merchants,
 * which leaks the schema and breaks the moment a status is renamed.
 */
export function vendorStatusLabel(status: OrderStatus, category?: string | null): string {
  const vertical = verticalOf(category);

  switch (status) {
    case 'placed':
    case 'vendor_reviewing':
      return 'New order';
    case 'accepted':
      return 'Accepted';
    case 'preparing':
      return vertical === 'restaurants'
        ? 'Preparing'
        : vertical === 'shops'
          ? 'Picking'
          : vertical === 'market'
            ? 'Sourcing'
            : 'Processing';
    case 'ready':
      return 'Awaiting rider';
    case 'rider_assigned':
      return 'Rider on the way';
    case 'rider_arrived':
      return 'Rider here';
    case 'picked_up':
    case 'en_route':
    case 'arrived':
      return 'Out for delivery';
    case 'delivered':
      return 'Delivered';
    case 'cancelled':
      return 'Cancelled';
    case 'rejected':
      return 'Rejected';
    case 'refunded':
      return 'Refunded';
    case 'disputed':
      return 'Under review';
    case 'draft':
    case 'payment_pending':
      return 'Not yet placed';
  }
}

/**
 * The button that starts the work — and the one transition that dispatches.
 *
 * `accepted → preparing` is the only normal trigger for rider dispatch, so this
 * verb is the moment a merchant commits. It has to describe what they are
 * actually about to do, or it is asking a pharmacist to "start preparing".
 */
export function vendorStartActionLabel(category?: string | null): string {
  switch (verticalOf(category)) {
    case 'restaurants':
      return 'Start preparing';
    case 'shops':
      return 'Start picking';
    case 'market':
      return 'Start sourcing';
    case 'pharmacy':
    case 'declutter':
      return 'Process order';
  }
}

/**
 * The coarse timeline a customer watches, already worded for their section.
 *
 * Returned as data so a screen renders a sequence it was given rather than one
 * it knows. The tracking page previously kept its own array — a second
 * vocabulary that had already drifted from the server's — and the redesign will
 * restyle this timeline heavily. Whatever it becomes, it should be given the
 * words.
 */
export function customerTimeline(
  category?: string | null,
): readonly { readonly key: string; readonly label: string }[] {
  const vertical = verticalOf(category);
  return [
    { key: 'confirming', label: 'Confirming' },
    { key: 'preparing', label: TIMELINE_PREPARING[vertical] },
    { key: 'on_the_way', label: 'On the way' },
    { key: 'complete', label: 'Delivered' },
  ];
}

/** Timeline steps are a word or two — the full sentence belongs on the status. */
const TIMELINE_PREPARING: Record<Vertical, string> = {
  restaurants: 'Preparing',
  shops: 'Picking',
  pharmacy: 'Processing',
  market: 'Sourcing',
  declutter: 'Processing',
};
