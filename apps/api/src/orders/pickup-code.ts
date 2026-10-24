/**
 * The pickup code: the four digits the assigned rider shows at the counter
 * and the vendor types in, so food is handed to the right rider.
 *
 * Checkout used to generate a random code and store only its hash — and never
 * give the plain code to anyone. No rider could ever know it, so the vendor
 * console's "Verify pickup code" could never succeed. The code is now derived
 * from the order id with a server-held key: the assigned rider's delivery
 * response carries it (until the order is picked up), and the vendor's check
 * recomputes it. Nothing needs storing, and a rider whose app restarts still
 * sees the same code.
 *
 * It is a handoff check between two people at one counter, not a credential:
 * it is shown only to the rider assigned to the order, and checked only by
 * the vendor who owns it.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** A distinct key per purpose, derived from the access-token secret (as the export download link is). */
function pickupKey(jwtAccessSecret: string): string {
  return `pickup-code.${jwtAccessSecret}`;
}

export function pickupCodeFor(orderId: string, jwtAccessSecret: string): string {
  const digest = createHmac('sha256', pickupKey(jwtAccessSecret)).update(orderId).digest();
  return String(digest.readUInt32BE(0) % 10_000).padStart(4, '0');
}

export function pickupCodeMatches(orderId: string, code: string, jwtAccessSecret: string): boolean {
  const expected = Buffer.from(pickupCodeFor(orderId, jwtAccessSecret));
  const given = Buffer.from(code);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Statuses in which the assigned rider is collecting, and so sees the code. */
export const PICKUP_CODE_VISIBLE = new Set(['rider_assigned', 'rider_arrived']);
