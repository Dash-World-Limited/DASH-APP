/**
 * Stable public service taxonomy.
 *
 * These ids are an API and analytics contract. Visible copy may be restyled,
 * but ids and order cannot change without an explicit compatibility plan.
 */

export const SERVICE_CATEGORY_IDS = [
  'food',
  'shops',
  'pharmacy',
  'local_market',
  'declutter',
  'logistics',
] as const;

export type ServiceCategoryId = (typeof SERVICE_CATEGORY_IDS)[number];
export type ServiceCategoryKind = 'merchant' | 'marketplace' | 'logistics';

export interface ServiceCategoryDefinition {
  readonly id: ServiceCategoryId;
  readonly label: string;
  readonly kind: ServiceCategoryKind;
  readonly position: number;
}

const SERVICE_METADATA = {
  food: { label: 'FOOD', kind: 'merchant' },
  shops: { label: 'SHOPS', kind: 'merchant' },
  pharmacy: { label: 'PHARMACY', kind: 'merchant' },
  local_market: { label: 'LOCAL MARKET', kind: 'merchant' },
  declutter: { label: 'DECLUTTER', kind: 'marketplace' },
  logistics: { label: 'LOGISTICS', kind: 'logistics' },
} as const satisfies Record<
  ServiceCategoryId,
  { readonly label: string; readonly kind: ServiceCategoryKind }
>;

export const SERVICE_CATEGORIES: readonly ServiceCategoryDefinition[] =
  SERVICE_CATEGORY_IDS.map((id, index) => ({
    id,
    ...SERVICE_METADATA[id],
    position: index + 1,
  }));

export const MERCHANT_SERVICE_CATEGORY_IDS = [
  'food',
  'shops',
  'pharmacy',
  'local_market',
] as const;

export type MerchantServiceCategoryId =
  (typeof MERCHANT_SERVICE_CATEGORY_IDS)[number];

/** Persisted values used by the existing merchant catalogue. */
export const LEGACY_VENDOR_CATEGORY_IDS = [
  'restaurant',
  'grocery',
  'pharmacy',
  'retail',
  'market',
] as const;

export type LegacyVendorCategory = (typeof LEGACY_VENDOR_CATEGORY_IDS)[number];

const VENDOR_CATEGORIES_BY_SERVICE: Record<
  MerchantServiceCategoryId,
  readonly LegacyVendorCategory[]
> = {
  food: ['restaurant'],
  shops: ['grocery', 'retail'],
  pharmacy: ['pharmacy'],
  local_market: ['market'],
};

const SERVICE_BY_VENDOR_CATEGORY: Record<
  LegacyVendorCategory,
  MerchantServiceCategoryId
> = {
  restaurant: 'food',
  grocery: 'shops',
  pharmacy: 'pharmacy',
  retail: 'shops',
  market: 'local_market',
};

export function isServiceCategoryId(value: unknown): value is ServiceCategoryId {
  return (
    typeof value === 'string' &&
    (SERVICE_CATEGORY_IDS as readonly string[]).includes(value)
  );
}

export function isMerchantServiceCategoryId(
  value: unknown,
): value is MerchantServiceCategoryId {
  return (
    typeof value === 'string' &&
    (MERCHANT_SERVICE_CATEGORY_IDS as readonly string[]).includes(value)
  );
}

export function isLegacyVendorCategory(
  value: unknown,
): value is LegacyVendorCategory {
  return (
    typeof value === 'string' &&
    (LEGACY_VENDOR_CATEGORY_IDS as readonly string[]).includes(value)
  );
}

export function vendorCategoriesForService(
  service: MerchantServiceCategoryId,
): readonly LegacyVendorCategory[] {
  return VENDOR_CATEGORIES_BY_SERVICE[service];
}

export function serviceCategoryForVendorCategory(
  category: string,
): MerchantServiceCategoryId | null {
  return isLegacyVendorCategory(category)
    ? SERVICE_BY_VENDOR_CATEGORY[category]
    : null;
}
