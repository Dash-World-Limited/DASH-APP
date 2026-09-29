/**
 * The six DASH services, as the Home grid presents them.
 *
 * Which services exist, their permanent ids and their order are the shared
 * contract in `@dash/domain/services` — the same list the API serves at
 * /v1/service-categories. Nothing here redefines them. What lives here is only
 * presentation the contract deliberately leaves to clients: the board's
 * title-case label, the line beneath it, the photograph, and where a tap
 * goes.
 *
 * Keyed by `ServiceCategoryId`, so a seventh service added to the contract is a
 * compile error here until it has been designed — rather than a blank tile.
 */

import {
  SERVICE_CATEGORIES,
  isServiceCategoryId,
  type ServiceCategoryDefinition,
  type ServiceCategoryId,
} from '@dash/domain/services';
import type { ImageSourcePropType } from 'react-native';

// Photography, not the board's drawings; source and licence to confirm (assets/services/README.md).
import declutterArt from '../../assets/services/declutter.png';
import foodArt from '../../assets/services/food.png';
import marketArt from '../../assets/services/local-market.png';
import logisticsArt from '../../assets/services/logistics.png';
import pharmacyArt from '../../assets/services/pharmacy.png';
import shopsArt from '../../assets/services/shops.png';

export interface ServicePresentation {
  /** The board's copy. The contract's all-caps label is the analytics name. */
  label: string;
  sublabel: string;
  art: ImageSourcePropType;
  /** Path of the destination. A plain string so this stays router-agnostic. */
  href: string;
  /**
   * Whether this checkpoint has a designed flow behind the tile. Declutter and
   * Logistics are separate domains still being defined — their tiles open an
   * honest "coming" screen, not a merchant list pretending to be them.
   */
  available: boolean;
}

export const SERVICE_PRESENTATION: Readonly<Record<ServiceCategoryId, ServicePresentation>> = {
  food: { label: 'Food', sublabel: 'Restaurants', art: foodArt, href: '/service/food', available: false },
  shops: { label: 'Shops', sublabel: 'Retail & More', art: shopsArt, href: '/shops', available: true },
  pharmacy: { label: 'Pharmacy', sublabel: 'Health & Wellness', art: pharmacyArt, href: '/service/pharmacy', available: false },
  local_market: { label: 'Local Market', sublabel: 'Fresh & Local', art: marketArt, href: '/service/local_market', available: false },
  declutter: { label: 'Declutter', sublabel: 'Buy & Sell', art: declutterArt, href: '/service/declutter', available: false },
  logistics: { label: 'Logistics', sublabel: 'Send & Deliver', art: logisticsArt, href: '/service/logistics', available: false },
};

export interface ServiceTileModel extends ServicePresentation {
  id: ServiceCategoryId;
  position: number;
}

/**
 * Combine the contract (from the API, or the bundled copy of the same
 * contract) with presentation, in the contract's order.
 *
 * Anything the server lists that this build does not know how to draw is left
 * out rather than drawn as a blank tile — an older app meeting a newer server
 * must degrade to "fewer doors", never to a broken one.
 */
export function toServiceTiles(categories: readonly unknown[]): ServiceTileModel[] {
  const tiles: ServiceTileModel[] = [];
  for (const entry of categories) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, position } = entry as Partial<ServiceCategoryDefinition>;
    if (!isServiceCategoryId(id) || typeof position !== 'number') continue;
    tiles.push({ id, position, ...SERVICE_PRESENTATION[id] });
  }
  return tiles.sort((a, b) => a.position - b.position);
}

/** The bundled contract, used before — or without — a server. */
export const BUNDLED_SERVICE_TILES: readonly ServiceTileModel[] = toServiceTiles(SERVICE_CATEGORIES);

/**
 * The fewest services this build must recognise in a server answer before it
 * replaces the bundled six. DASH APP once collapsed its categories until only
 * "Everything" was left; a Home grid of one door is that failure, not a
 * decision. Operations can still hide a service (five doors is an answer), but
 * an answer that leaves one or none is treated as a server fault.
 */
export const MIN_SERVER_SERVICES = 2;

/** The server's tiles, or null to keep the bundled contract. */
export function tilesFromServer(body: unknown): ServiceTileModel[] | null {
  const categories =
    body && typeof body === 'object' && Array.isArray((body as { categories?: unknown }).categories)
      ? (body as { categories: unknown[] }).categories
      : [];
  const tiles = toServiceTiles(categories);
  return tiles.length >= MIN_SERVER_SERVICES ? tiles : null;
}
