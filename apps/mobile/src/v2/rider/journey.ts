/**
 * The rider's delivery journey as one sequence: what the rider is doing now,
 * where they are going, and the single action that moves the order on.
 *
 * Pure, so the screens can stay thin and every rule here is tested directly.
 * Nothing in this file invents data: distances are measured between real
 * coordinates and are labelled as straight-line, because DASH has no routing
 * provider and must not draw or describe a road route it does not have.
 */

import type { Coordinate, DeliveryStatus } from './RiderFlowProvider';

/** The five steps a rider sees, in order. `delivered` is the end, not a step. */
export const JOURNEY_STEPS = ['Go to pickup', 'At pickup', 'Collected', 'On the way', 'At drop-off'] as const;

export type JourneyTarget = 'pickup' | 'dropoff';

export type JourneyAction =
  | { kind: 'progress'; to: Exclude<DeliveryStatus, 'rider_assigned' | 'delivered'>; label: string }
  | { kind: 'pin'; label: string };

export interface JourneyStage {
  /** Index into JOURNEY_STEPS; 5 once delivered. */
  step: number;
  /** Where the rider should be heading, or null once delivered. */
  target: JourneyTarget | null;
  /** Short status for the header pill. */
  label: string;
  /** One sentence telling the rider what to do now. */
  instruction: string;
  /** The one thing that moves the order on, or null once delivered. */
  action: JourneyAction | null;
}

/**
 * Every transition here is one the server accepts from the rider
 * (`assertTransition(..., 'rider')` in the API), in the order it accepts them.
 */
export function journeyStage(status: DeliveryStatus): JourneyStage {
  switch (status) {
    case 'rider_assigned':
      return {
        step: 0,
        target: 'pickup',
        label: 'Heading to pickup',
        instruction: 'Go to the shop. Tell them your pickup code when you arrive.',
        action: { kind: 'progress', to: 'rider_arrived', label: 'I’ve arrived at the shop' },
      };
    case 'rider_arrived':
      return {
        step: 1,
        target: 'pickup',
        label: 'At pickup',
        instruction: 'Give the shop your pickup code, check the items, then confirm you have them.',
        action: { kind: 'progress', to: 'picked_up', label: 'I have the order' },
      };
    case 'picked_up':
      return {
        step: 2,
        target: 'dropoff',
        label: 'Order collected',
        instruction: 'Start the trip when you are ready to leave the shop.',
        action: { kind: 'progress', to: 'en_route', label: 'Start trip to customer' },
      };
    case 'en_route':
      return {
        step: 3,
        target: 'dropoff',
        label: 'On the way',
        instruction: 'Head to the drop-off. Confirm when you are at the address.',
        action: { kind: 'progress', to: 'arrived', label: 'I’ve arrived at drop-off' },
      };
    case 'arrived':
      return {
        step: 4,
        target: 'dropoff',
        label: 'At drop-off',
        instruction: 'Hand over the order and ask the customer for their 4-digit delivery PIN.',
        action: { kind: 'pin', label: 'Complete delivery' },
      };
    case 'delivered':
      return { step: 5, target: null, label: 'Delivered', instruction: 'Handover confirmed.', action: null };
  }
}

/**
 * The shop asks for the pickup code at the counter. The server sends it only
 * while the order waits for collection, so the app shows it for exactly those
 * two states.
 */
export function pickupCodeVisible(status: DeliveryStatus): boolean {
  return status === 'rider_assigned' || status === 'rider_arrived';
}

const EARTH_RADIUS_METRES = 6_371_008.8;

/** Great-circle distance between two real coordinates. Straight line, not road distance. */
export function straightLineMetres(a: Coordinate, b: Coordinate): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres) || metres < 0) return '—';
  if (metres < 1_000) return `${Math.max(10, Math.round(metres / 10) * 10)} m`;
  return `${(metres / 1_000).toFixed(metres < 10_000 ? 1 : 0)} km`;
}

/** "about 6 min" — always an estimate, so always worded as one. */
export function formatEta(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `about ${minutes} min`;
}

/** How long ago something happened, for "checked 4s ago" and GPS freshness. */
export function formatAgo(thenMs: number | null, nowMs: number): string | null {
  if (thenMs === null) return null;
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1_000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)} min ago`;
}

/**
 * GPS freshness as the rider should read it. Dispatch only offers work to a
 * rider whose position is fresh, so a stale fix is worth saying out loud.
 */
export function gpsFreshness(updatedAtMs: number | null, nowMs: number): 'none' | 'live' | 'stale' {
  if (updatedAtMs === null) return 'none';
  return nowMs - updatedAtMs <= 30_000 ? 'live' : 'stale';
}

/**
 * The offer's countdown window for the ring. The server decides the expiry;
 * the ring is drawn against the time that was left when this phone first saw
 * the offer, so it starts full and empties to the server's deadline.
 */
export function offerWindowSeconds(expiresAt: string, firstSeenAtMs: number): number {
  const deadline = Date.parse(expiresAt);
  if (Number.isNaN(deadline)) return 1;
  return Math.max(1, Math.ceil((deadline - firstSeenAtMs) / 1_000));
}

/**
 * Hand-off to the phone's own navigation app, which has the road network.
 * Android's `geo:` intent lets the rider pick Google Maps, Waze or whatever
 * they use; DASH supplies only the destination.
 */
export function externalNavigationUrl(destination: Coordinate, label: string, platform: 'ios' | 'android' | 'web'): string {
  const { latitude, longitude } = destination;
  const query = encodeURIComponent(label);
  if (platform === 'ios') return `http://maps.apple.com/?daddr=${latitude},${longitude}&q=${query}`;
  if (platform === 'android') return `geo:${latitude},${longitude}?q=${latitude},${longitude}(${query})`;
  return `https://www.openstreetmap.org/directions?to=${latitude}%2C${longitude}`;
}
