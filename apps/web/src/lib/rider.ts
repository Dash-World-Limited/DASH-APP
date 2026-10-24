'use client';

/**
 * The rider's working state, and what it means for location reporting.
 *
 * The server models four states; the rider's screen only ever offers three,
 * because `on_delivery` is not something a rider chooses — the server sets it
 * when an offer is accepted and clears it when the delivery completes.
 *
 * That gap is the risk this module exists to close. The rider screen keeps its
 * own `availability` for the online/offline control, and hydration folds the
 * server's `on_delivery` into `idle` so the screen reads as "working". Location
 * reporting is gated on that same value, so the fold is load-bearing: it is the
 * only reason a rider on a delivery keeps reporting a position at all. Written
 * as an inline ternary it looked like a display detail, and anyone later
 * deciding the screen should distinguish the two states would have silently
 * switched off tracking at the exact moment tracking matters most — while a
 * customer is watching a rider approach.
 *
 * So the rule is stated here, once, over the server's own vocabulary, and
 * asserted in tests: reporting stops when the rider is offline, and in no
 * other case.
 */

/** What the server stores. */
export type RiderAvailability = 'offline' | 'idle' | 'on_break' | 'on_delivery';

/** What the rider's online/offline control can express. */
export type ScreenAvailability = 'offline' | 'idle' | 'on_break';

/**
 * Whether to report a position in this state.
 *
 * The platform does not track a rider who is not working — an offline rider's
 * position is not the platform's business — and the server enforces that
 * independently by refusing a position from an offline rider with
 * `rider_offline`. This is the client half of the same rule.
 *
 * `on_break` reports nothing for the same reason as `offline`: the rider has
 * stepped away and is not accepting work. `on_delivery` reports, because a
 * delivery in progress is the single most important time to know where the
 * rider is.
 */
export function shouldReportLocation(availability: RiderAvailability): boolean {
  return availability === 'idle' || availability === 'on_delivery';
}

/**
 * The server's state as the online/offline control should show it.
 *
 * A rider on a delivery is working, and the control should say so rather than
 * appearing offline while a job is in progress.
 */
export function toScreenAvailability(server: RiderAvailability): ScreenAvailability {
  return server === 'on_delivery' ? 'idle' : server;
}

/**
 * Whether a failed offer response means the offer is simply gone.
 *
 * A dispatch offer is a race by design. It expires after thirty seconds, it
 * can be taken by another rider first, and a rider who taps twice answers an
 * offer they have already answered. The server refuses all three the same way
 * — `409 That offer is no longer available.` — and a `404` means the offer no
 * longer exists or was never this rider's to answer.
 *
 * None of those is a malfunction. They are the normal outcome of a timed race,
 * and the cure is always the same: re-read the server's own view of this
 * rider's work. What must NOT happen is for them to be treated as a crash, or
 * for every failure to be swallowed alongside them — a 500, a network drop or
 * an expired session are real faults and still have to surface.
 */
export function isOfferNoLongerAvailable(error: { status: number }): boolean {
  return error.status === 409 || error.status === 404;
}

/**
 * Whether this build may show the location diagnostics panel.
 *
 * The panel states, in order, what the location path actually did — bridge,
 * plugin, permission, fix, send, server answer. Every failure in that chain
 * has been silent at least once, and each cost a round of physical testing to
 * find, so it earns its place on a test handset. It has no place in front of a
 * real rider, who cannot act on any of it.
 *
 * A production build is refused outright, with no flag to override it. An
 * escape hatch would be a way for the panel to reach real users — through a
 * mistaken deployment variable, or a build script someone copied — in exchange
 * for a capability nothing needs: the test APK loads from the development
 * server, so a production bundle has never been where diagnostics were wanted.
 *
 * `NODE_ENV` is substituted by Next at build time, so in production this folds
 * to `false` and the block it guards is eliminated rather than merely hidden.
 * That is the property being relied on, and it is verified by grepping the
 * built chunk rather than assumed — an earlier version of this gate read a
 * `NEXT_PUBLIC_` flag, which Next does not substitute unless the variable is
 * actually defined, so the expression stayed dynamic and shipped the panel
 * into production while looking correct.
 */
export function diagnosticsEnabled(): boolean {
  return process.env.NODE_ENV !== 'production';
}
