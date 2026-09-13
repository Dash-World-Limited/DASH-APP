/**
 * An incoming offer's clock.
 *
 * The countdown is computed from the server's `expiresAt`, never from a timer
 * started when the screen opened. A rider woken from a killed app opens the
 * offer some seconds after it was made; a local thirty-second timer would show
 * time the rider does not have, and the server — which is the one that expires
 * offers — would refuse an acceptance the screen said was still open.
 *
 * The window differs by liveness, as the dispatch engine decides: thirty
 * seconds for a rider whose app is live, ninety for one who had to be woken.
 * The ring is drawn against the offer's own window.
 *
 * Pure: tested directly.
 */

export function secondsLeft(expiresAt: string, now: number): number {
  const deadline = Date.parse(expiresAt);
  if (Number.isNaN(deadline)) return 0;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** 1 when the offer has just arrived, 0 when it has gone. */
export function remainingFraction(expiresAt: string, windowSeconds: number, now: number): number {
  if (windowSeconds <= 0) return 0;
  return Math.min(1, Math.max(0, (Date.parse(expiresAt) - now) / (windowSeconds * 1000)));
}

export type OfferPhase = 'open' | 'expired';

export function offerPhase(expiresAt: string, now: number): OfferPhase {
  return secondsLeft(expiresAt, now) > 0 ? 'open' : 'expired';
}
