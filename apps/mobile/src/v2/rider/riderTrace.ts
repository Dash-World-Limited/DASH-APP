/**
 * Breadcrumbs for the rider location lifecycle, so a field failure on the
 * staging APK can be read in order from `adb logcat -s ReactNativeJS`: app
 * state changes, permission checks, GPS fixes, the watch and Go online.
 *
 * Staging only — a release build, so `console.warn` goes straight to logcat
 * with no LogBox. Never coordinates or anything personal: only what happened,
 * why, and how long it took.
 */

import { buildVariant } from '../../api';

export type RiderTraceDetail = Record<string, string | number | boolean | null | undefined>;

export function riderTrace(event: string, detail?: RiderTraceDetail): void {
  if (buildVariant !== 'staging') return;
  console.warn(`[DASH_RIDER] ${event}${detail ? ` ${JSON.stringify(detail)}` : ''}`);
}
