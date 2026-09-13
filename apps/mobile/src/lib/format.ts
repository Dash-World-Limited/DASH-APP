/**
 * Display formatting for the figures the boards show.
 *
 * Money is not here: it is formatted by `formatNairaCompact` from
 * @dash/domain/money, the same function the web product uses, so ₦1,250,000
 * reads identically on every DASH surface.
 *
 * Pure: tested directly.
 */

/** 850 → "850 m", 1200 → "1.2 km", 12500 → "12.5 km". */
export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres) || metres < 0) return '';
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

/** 1200 → "1.2k", 320 → "320". Review and order counts on cards. */
export function formatCount(count: number): string {
  if (count >= 1000) {
    const thousands = count / 1000;
    return `${thousands >= 10 ? Math.round(thousands) : Number(thousands.toFixed(1))}k`;
  }
  return String(count);
}

/** Always one decimal, as the boards print ratings: 4 → "4.0". */
export function formatRating(average: number): string {
  return average.toFixed(1);
}

/** {20, 35} → "20–35 mins". An estimate, and the dash says so. */
export function formatEta(eta: { min: number; max: number }): string {
  return eta.min === eta.max ? `${eta.min} mins` : `${eta.min}–${eta.max} mins`;
}

/** The greeting on both Home boards, from the hour of the device clock. */
export function greetingFor(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}
