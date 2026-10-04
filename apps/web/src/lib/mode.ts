'use client';

/**
 * Which face of DASH the app is showing.
 *
 * One identity, one session, two experiences. Everybody is a Customer; an
 * identity whose rider profile has been approved may also work, and switches
 * between the two without signing in again.
 *
 * The distinction this module exists to hold is that **mode is presentation
 * and nothing else**. It decides which screens render. It grants no access
 * whatsoever: every rider route is authorised server-side against the caller's
 * own identity, and a customer-only account is refused whatever this says. The
 * remembered value is a convenience so the app reopens where the rider left
 * it, and is treated as a request, never as a fact.
 *
 * Eligibility therefore comes from one place only — `riderStatus` in the
 * `/v1/auth/me` payload — and is recomputed on every hydration. A rider
 * approved yesterday and suspended overnight reopens the app in Customer mode,
 * because the server said so, regardless of what the device remembers.
 */

import type { Me } from './api';

export type AppMode = 'customer' | 'rider';

/** Where the remembered mode lives. Per-device, never sent anywhere. */
const STORAGE_KEY = 'dash.mode';

/**
 * Whether this account may enter rider mode.
 *
 * `riderStatus === 'approved'` and nothing else. Not the presence of a
 * `riderId` — a pending, suspended or rejected rider has one — and not a role,
 * a remembered preference, or a route the user typed.
 */
export function canUseRiderMode(me: Me | null): boolean {
  return me?.riderStatus === 'approved';
}

/**
 * The mode to actually render, given what the server says and what the device
 * remembers.
 *
 * The remembered value only ever narrows: it can keep an eligible rider in
 * rider mode, and it can never put an ineligible one there. This is the
 * function that makes a forged `localStorage` entry inert.
 */
export function resolveMode(me: Me | null, remembered: AppMode | null): AppMode {
  if (remembered === 'rider' && canUseRiderMode(me)) return 'rider';
  return 'customer';
}

/** Read the remembered mode. Absent, unreadable or nonsense all mean none. */
export function readRememberedMode(): AppMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'rider' || value === 'customer' ? value : null;
  } catch {
    // Private browsing, blocked site data, or a locked-down WebView. A
    // remembered preference is a nicety; failing to read it is not an error.
    return null;
  }
}

/** Remember the mode for next launch. Best effort, never load-bearing. */
export function rememberMode(mode: AppMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // See above. The app works without it.
  }
}

/** The route each mode lands on. */
export function homeFor(mode: AppMode): string {
  return mode === 'rider' ? '/rider' : '/home';
}
