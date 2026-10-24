'use client';

/**
 * Whether a rider may tap Accept yet.
 *
 * The server refuses to assign a delivery unless the rider's position is under
 * two minutes old. A rider woken from a killed app by a push has no position
 * at all — that is the whole reason the push was allowed to reach them — so
 * without this the first thing they would do after waking is tap Accept, be
 * told "DASH needs a current location", and then wait out a twenty-second
 * reporting tick before they could try again. Correct, and infuriating.
 *
 * So the app confirms location *before* offering the button, and says so while
 * it happens. The rule is deliberately about the age of the position rather
 * than about how the offer was made: an offer created from a fresh position is
 * still refused if the rider sat looking at it until the position went stale,
 * and a rider whose app never stopped reporting is never made to wait. Branching
 * on `eligibilityMode` would have handled the woken case and missed that one.
 *
 * None of this is authority. The server re-checks everything at acceptance and
 * refuses independently; this exists so the rider is not sent to press a button
 * that cannot work yet.
 */

/** What the accept button should be doing right now. */
export type ReadinessState =
  /** Position is current. Accept works. */
  | 'ready'
  /** Acquiring and reporting a position. Accept disabled, briefly. */
  | 'confirming'
  /** Cannot confirm. Accept disabled, with a reason worth reading. */
  | 'blocked';

export interface Readiness {
  readonly state: ReadinessState;
  /** Shown under the offer. Empty when ready — silence is the success case. */
  readonly message: string;
}

/**
 * How much younger than the server's limit a position must be to be trusted.
 *
 * The server refuses anything over `maxAgeSeconds`, measured when the
 * acceptance arrives. A position that is 118 seconds old when the button
 * renders is 121 by the time the rider has read the address and tapped, so
 * treating the server's exact limit as this side's limit would produce
 * refusals that look arbitrary. The margin covers the reading, the tap and the
 * round trip.
 */
export const FRESHNESS_MARGIN_SECONDS = 30;

/**
 * Whether a position this old should be refreshed before offering Accept.
 *
 * `null` means nothing has ever been accepted by the server for this rider —
 * a cold start, which is exactly the woken-by-push case.
 */
export function needsFreshFix(
  ageSeconds: number | null,
  maxAgeSeconds: number,
): boolean {
  if (ageSeconds === null) return true;
  return ageSeconds > Math.max(0, maxAgeSeconds - FRESHNESS_MARGIN_SECONDS);
}

/** Why confirmation failed, in the rider's terms. */
export type ConfirmationFailure =
  | 'permission_denied'
  | 'no_fix'
  | 'rejected_by_server'
  | 'offline';

const FAILURE_MESSAGES: Record<ConfirmationFailure, string> = {
  permission_denied:
    'DASH needs location access to give you deliveries. Turn it on in Settings and reopen DASH.',
  no_fix: 'Waiting for GPS. Step outside or into the open if you can.',
  rejected_by_server: 'DASH could not confirm your location. Trying again.',
  offline: 'Go online to accept deliveries.',
};

/**
 * The readiness of the accept button, from what the app currently knows.
 *
 * Pure: everything it needs is an argument, so the states a rider can actually
 * end up in are enumerable in a test rather than reachable only by holding a
 * handset in a basement.
 */
export function readiness(input: {
  /** Age of the last position the *server* accepted, in seconds. */
  locationAgeSeconds: number | null;
  /** The server's own freshness limit, so this cannot drift from it. */
  maxAgeSeconds: number;
  /** True while a fix is being acquired or reported. */
  confirming: boolean;
  /** Set when the last confirmation attempt failed. */
  failure?: ConfirmationFailure | null;
}): Readiness {
  if (input.failure) {
    return { state: 'blocked', message: FAILURE_MESSAGES[input.failure] };
  }

  if (input.confirming) {
    return { state: 'confirming', message: 'Confirming your location…' };
  }

  if (needsFreshFix(input.locationAgeSeconds, input.maxAgeSeconds)) {
    // Not an error: the app simply has not confirmed a position yet, and is
    // about to. Saying anything alarming here would be wrong — this is the
    // ordinary state of a rider who has just been woken.
    return { state: 'confirming', message: 'Confirming your location…' };
  }

  return { state: 'ready', message: '' };
}

/** Whether the accept button should be usable. */
export function canAccept(state: ReadinessState): boolean {
  return state === 'ready';
}
