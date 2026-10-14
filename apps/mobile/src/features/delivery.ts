/**
 * Delivery experience rules the screens share: when the customer may call
 * their rider, how a rating reads, how a reverse-geocoded place becomes an
 * address line, and what the home screen's location line says.
 *
 * Plain functions, so the rules are tested without rendering anything.
 */

import { isOrderStatus, isRiderOnOrder } from '@dash/domain/orders';

// ---------------------------------------------------------------- calling the rider

const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * The `tel:` link for the rider on this order, or null when there is no one to
 * call: no rider, a number that is not a real E.164 number, or an order the
 * rider is not working. The server only sends the number while the rider is
 * working the order; this checks again so a stale screen never offers a call.
 */
export function riderCallUrl(order: { status: string; rider: { phone?: string | null } | null }): string | null {
  if (!isOrderStatus(order.status) || !isRiderOnOrder(order.status)) return null;
  const phone = order.rider?.phone?.replace(/[\s()-]/g, '') ?? '';
  return E164.test(phone) ? `tel:${phone}` : null;
}

// ---------------------------------------------------------------- rating the rider

export const RATING_STARS = [1, 2, 3, 4, 5] as const;

const RATING_WORDS: Record<number, string> = {
  1: 'Poor',
  2: 'Fair',
  3: 'Good',
  4: 'Very good',
  5: 'Excellent',
};

export function ratingWord(stars: number): string {
  return RATING_WORDS[stars] ?? '';
}

// ---------------------------------------------------------------- reverse geocoding

/** The parts of expo-location's LocationGeocodedAddress this reads. */
export interface GeocodedPlace {
  name?: string | null;
  streetNumber?: string | null;
  street?: string | null;
  district?: string | null;
  subregion?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  formattedAddress?: string | null;
}

/** A Google Plus Code, e.g. "8FVC9G8F+6X". Precise, but not an address. */
const PLUS_CODE = /^[23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{0,3}$/i;
const ADDRESS_MAX = 200;

function cleanParts(parts: ReadonlyArray<string | null | undefined>, country: string | null | undefined): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of parts) {
    const part = (raw ?? '').trim();
    const key = part.toLowerCase();
    if (!part || PLUS_CODE.test(part) || seen.has(key)) continue;
    if (country && key === country.trim().toLowerCase()) continue;
    seen.add(key);
    kept.push(part);
  }
  return kept;
}

function streetLine(place: GeocodedPlace): string | null {
  const street = place.street?.trim();
  const number = place.streetNumber?.trim();
  if (street) return number ? `${number} ${street}` : street;
  return place.name?.trim() || null;
}

/**
 * A readable address line for a reverse-geocoded place, or null when the
 * geocoder gave nothing a person could read. Prefers the platform's own
 * formatted line (Android's Geocoder writes a good one) and drops the country
 * and any Plus Code, which say nothing to a rider in Asaba.
 */
export function describePlace(place: GeocodedPlace | null | undefined): string | null {
  if (!place) return null;
  const formatted = cleanParts((place.formattedAddress ?? '').split(','), place.country);
  const composed = cleanParts([streetLine(place), place.district, place.city ?? place.subregion, place.region], place.country);
  const best = formatted.length >= 2 ? formatted : composed.length > 0 ? composed : formatted;
  if (best.length === 0) return null;
  return best.join(', ').slice(0, ADDRESS_MAX).trim();
}

// ---------------------------------------------------------------- the home screen line

export type HomeLocation =
  | { kind: 'loading' }
  /** The customer's chosen delivery address: their default saved address. */
  | { kind: 'confirmed'; label: string | null; line1: string }
  /** Where the phone is now, not yet confirmed as a delivery address. */
  | { kind: 'detected'; description: string | null }
  | { kind: 'denied'; canAskAgain: boolean }
  | { kind: 'unavailable' };

/** The two lines under DASH on the customer home screen. */
export function homeLocationLines(location: HomeLocation): { caption: string; title: string; accessibilityLabel: string } {
  switch (location.kind) {
    case 'loading':
      return { caption: 'Delivering to', title: 'Finding your location…', accessibilityLabel: 'Finding your location. Choose a delivery location' };
    case 'confirmed': {
      const title = location.label ? `${location.label} · ${location.line1}` : location.line1;
      return { caption: 'Delivering to', title, accessibilityLabel: `Delivering to ${title}. Change delivery location` };
    }
    case 'detected': {
      const title = location.description ?? 'Your current location';
      return { caption: 'You are near · tap to confirm', title, accessibilityLabel: `You are near ${title}. Confirm your delivery location` };
    }
    case 'denied':
      return {
        caption: 'Delivery location',
        title: 'Set your delivery location',
        accessibilityLabel: 'Location is off for DASH. Set your delivery location',
      };
    case 'unavailable':
      return {
        caption: 'Delivery location',
        title: 'Set your delivery location',
        accessibilityLabel: 'Your location could not be found. Set your delivery location',
      };
  }
}
