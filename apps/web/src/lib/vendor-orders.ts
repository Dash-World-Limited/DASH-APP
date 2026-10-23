/**
 * What the vendor console offers for an order, by its status.
 *
 * Kept apart from the page so the rules can be tested, because getting them
 * wrong stops a handoff at the counter:
 *
 *   - Dispatch starts at `preparing`, so a rider usually accepts while the
 *     kitchen is still cooking. The status then belongs to the rider
 *     (`rider_assigned`, `rider_arrived`), and "food ready" is recorded as
 *     `readyAt` without changing it. The button has to stay available until
 *     that is recorded.
 *   - The rider reads the pickup code at the counter, which is usually after
 *     they have marked themselves arrived. Verifying must be offered then.
 */

export interface VendorOrderLike {
  status: string;
  readyAt?: string | null;
  /** From the API: whether DASH is finding a rider, or finding another one. */
  riderSearch?: 'finding' | 'finding_another' | null;
}

export interface VendorActions {
  accept: boolean;
  reject: boolean;
  startPreparing: boolean;
  markReady: boolean;
  /** Food ready has been recorded on an order a rider already holds. */
  foodReadyRecorded: boolean;
  verifyPickup: boolean;
  /** Cancel an accepted order the vendor can no longer fulfil, until a rider collects it. */
  cancel: boolean;
  /** What to say where the rider would be, while nobody is assigned. */
  riderSearchNote: string | null;
  /** Stop: the order was cancelled or rejected. */
  stopped: boolean;
}

/** From accepting until a rider takes the food. Before accepting, Reject is the answer. */
const VENDOR_CANCELLABLE = new Set(['accepted', 'preparing', 'ready', 'rider_assigned', 'rider_arrived']);

const RIDER_AT_OR_COMING = new Set(['rider_assigned', 'rider_arrived']);

export function vendorActions(order: VendorOrderLike): VendorActions {
  const riderHasIt = RIDER_AT_OR_COMING.has(order.status);
  const readyRecorded = Boolean(order.readyAt);
  return {
    accept: order.status === 'placed' || order.status === 'vendor_reviewing',
    reject: order.status === 'placed' || order.status === 'vendor_reviewing',
    startPreparing: order.status === 'accepted',
    markReady: order.status === 'preparing' || (riderHasIt && !readyRecorded),
    foodReadyRecorded: riderHasIt && readyRecorded,
    verifyPickup: order.status === 'ready' || riderHasIt,
    cancel: VENDOR_CANCELLABLE.has(order.status),
    riderSearchNote:
      order.riderSearch === 'finding_another'
        ? 'The rider who accepted could not continue. DASH is finding another rider.'
        : order.riderSearch === 'finding'
          ? 'DASH is finding a rider. Nobody is on the way yet.'
          : null,
    stopped: order.status === 'cancelled' || order.status === 'rejected',
  };
}

/** The server accepts 1–180 minutes; these are the choices offered. */
export const PREP_TIME_CHOICES = [10, 15, 20, 30, 45, 60] as const;

/**
 * The prep-time choices for accepting an order: the usual ones plus the
 * branch's own default, which is what is pre-selected.
 */
export function prepTimeChoices(branchDefault: number | null | undefined): { choices: number[]; initial: number } {
  const initial =
    typeof branchDefault === 'number' && Number.isInteger(branchDefault) && branchDefault >= 1 && branchDefault <= 180
      ? branchDefault
      : 20;
  const choices = [...new Set<number>([...PREP_TIME_CHOICES, initial])].sort((a, b) => a - b);
  return { choices, initial };
}
