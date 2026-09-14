/**
 * What each screen is given to draw.
 *
 * Where the API already serves a shape, the model mirrors it field for field,
 * so wiring a screen later is a mapping rather than a redesign. Where a board
 * shows something the API does not serve yet, the field is optional and the
 * gap is written next to it — so nobody mistakes a staging fixture for a
 * working feature.
 *
 * Money is integer kobo throughout (`Kobo` from @dash/domain/money). The app
 * formats it; it never computes a total, fee or price.
 */

import type { Kobo } from '@dash/domain/money';
import type { ImageSourcePropType } from 'react-native';

export interface ShopCategoryModel {
  id: string;
  label: string;
  /** Null draws the grid glyph used for "All". */
  image: ImageSourcePropType | null;
}

export interface MerchantModel {
  slug: string;
  name: string;
  /** "Electronics & Gadgets". GAP: the API has one coarse vendor category, not this line. */
  descriptor: string;
  /** The API's vendor category (`grocery`, `retail`…), which the category doors filter on. */
  category?: string;
  /** GAP: `Vendor` has no cover or logo image field yet. Null draws the designed placeholder. */
  cover: ImageSourcePropType | null;
  logo: ImageSourcePropType | null;
  rating: { average: number; count: number } | null;
  /** Minutes, low and high. The API serves one estimate per branch; a range needs a server change. */
  eta: { min: number; max: number } | null;
  /** The shop's own words about itself, where it has written some. */
  description?: string;
}

export interface ProductOptionGroup {
  id: string;
  label: string;
  kind: 'swatch' | 'chip';
  /** `priceDelta` (kobo) is shown on the option; the server prices the order. */
  options: readonly { id: string; label: string; swatch?: string; priceDelta?: number }[];
  /** Pre-selected option. The first option when absent. */
  defaultOption?: string;
}

export interface ProductModel {
  id: string;
  merchantSlug: string;
  name: string;
  /** Short line under the name in the cart: "256GB, Natural Titanium". */
  price: Kobo;
  /** Null draws the designed placeholder: the API cannot resolve storage keys yet. */
  image: ImageSourcePropType | null;
  /**
   * GAP: `MenuItem` holds one image. A gallery needs an additive image table.
   */
  gallery: readonly ImageSourcePropType[];
  description: string;
  /** Product ratings do not exist in the backend; vendor ratings do. */
  rating: { average: number; count: number } | null;
  /**
   * Colour and storage. The API's modifier groups (min/max select, price
   * delta) can carry these; not yet mapped.
   */
  optionGroups: readonly ProductOptionGroup[];
  /** The storefront filter this product sits under. */
  shelf: string;
  /** The shelf's name as the shop wrote it ("Produce"), where known. */
  shelfLabel?: string;
  /** False when the shop has marked it unavailable. Treated as available when absent. */
  available?: boolean;
}

/**
 * A quote for the cart, as the server would return it.
 *
 * The cart never adds anything up itself. In staging the quote comes from the
 * fixture module; wired, it is `/v1/orders/quote`, which is where fees are
 * decided.
 */
export interface QuoteModel {
  itemCount: number;
  itemsTotal: Kobo;
  deliveryFee: Kobo;
  serviceFee: Kobo;
  total: Kobo;
}

// --- Rider -------------------------------------------------------------------

export interface RiderProfileModel {
  firstName: string;
  avatar: ImageSourcePropType | null;
  rating: number;
  trips: number;
}

export interface RiderTodayModel {
  /** GAP: rider earnings are not served. The ledger can derive them; no endpoint yet. */
  earnings: Kobo;
  trips: number;
  rating: number;
  /** Percentage, 0-100. */
  completion: number;
}

export interface Coordinate {
  latitude: number;
  longitude: number;
}

/**
 * An offer, before the rider has accepted it.
 *
 * Mirrors GET /v1/rider/offers exactly, and deliberately carries **no customer
 * fields at all** — no name, no street, no phone. The server sends only a
 * drop-off *area*, coarsened, because "a rider who has not accepted yet has no
 * business knowing where the customer lives". The approved board shows a
 * customer name on this screen; that is reported as a conflict with the
 * privacy rule, and the rule stands. Leaving the fields off the type is what
 * makes the name impossible to show here, fixture or not.
 */
export interface RiderOfferModel {
  id: string;
  expiresAt: string;
  /** The total window, for drawing the countdown ring: 30s live, 90s wake. */
  windowSeconds: number;
  pickupDistanceMetres: number;
  order: {
    code: string;
    pickup: {
      name: string;
      address: string;
      coordinate: Coordinate;
      /** Merchant type and rating are not in the offer projection today. */
      kind?: string;
      rating?: { average: number; count: number };
      image?: ImageSourcePropType;
    };
    /** Coarsened to ~100m by the server. Named for display by reverse lookup, never by the customer. */
    dropoffArea: { coordinate: Coordinate; label: string } | null;
    tripDistanceMetres: number;
    itemCount: number;
  };
  /** GAP: the offer projection carries no rider earnings figure. */
  estimatedEarnings?: Kobo;
}

/**
 * An accepted delivery.
 *
 * Mirrors the rider delivery projection (ACTIVE_DELIVERY_SELECT): after
 * acceptance the rider is given the address line, landmark, instructions and a
 * contact phone, because they now have to go there.
 */
export interface RiderJobModel {
  id: string;
  code: string;
  merchant: {
    name: string;
    address: string;
    phone: string | null;
    coordinate: Coordinate;
    image?: ImageSourcePropType;
    rating?: { average: number; count: number };
  };
  dropoff: {
    line1: string;
    landmark: string | null;
    instructions: string | null;
    contactPhone: string | null;
    coordinate: Coordinate;
  };
  /**
   * GAP: the projection does not include the customer's name, and customer
   * ratings are not a DASH concept. First name and initial after acceptance is
   * a proposed projection change needing approval; staging shows the board's.
   */
  customer: { displayName: string | null; rating?: { average: number; orders: number } };
  items: readonly { name: string; quantity: number }[];
  pickupNote: string | null;
  /** Route polyline to the merchant. From a routing provider later; a staging line now. */
  routeToPickup: readonly Coordinate[];
  etaToPickupMinutes: number;
  distanceToPickupMetres: number;
}
