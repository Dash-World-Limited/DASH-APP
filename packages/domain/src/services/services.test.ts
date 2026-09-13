import { describe, expect, it } from 'vitest';
import {
  MERCHANT_SERVICE_CATEGORY_IDS,
  SERVICE_CATEGORIES,
  SERVICE_CATEGORY_IDS,
  isLegacyVendorCategory,
  isMerchantServiceCategoryId,
  isServiceCategoryId,
  serviceCategoryForVendorCategory,
  vendorCategoriesForService,
} from './index.js';

describe('public service taxonomy', () => {
  it('locks the six categories and their permanent order', () => {
    expect(SERVICE_CATEGORY_IDS).toEqual([
      'food',
      'shops',
      'pharmacy',
      'local_market',
      'declutter',
      'logistics',
    ]);
    expect(SERVICE_CATEGORIES.map(({ label }) => label)).toEqual([
      'FOOD',
      'SHOPS',
      'PHARMACY',
      'LOCAL MARKET',
      'DECLUTTER',
      'LOGISTICS',
    ]);
    expect(SERVICE_CATEGORIES.map(({ position }) => position)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('keeps marketplace and logistics out of merchant catalogue filters', () => {
    expect(MERCHANT_SERVICE_CATEGORY_IDS).toEqual([
      'food',
      'shops',
      'pharmacy',
      'local_market',
    ]);
    expect(isMerchantServiceCategoryId('declutter')).toBe(false);
    expect(isMerchantServiceCategoryId('logistics')).toBe(false);
  });

  it('maps legacy vendor storage without rewriting historical rows', () => {
    expect(vendorCategoriesForService('food')).toEqual(['restaurant']);
    expect(vendorCategoriesForService('shops')).toEqual(['grocery', 'retail']);
    expect(vendorCategoriesForService('pharmacy')).toEqual(['pharmacy']);
    expect(vendorCategoriesForService('local_market')).toEqual(['market']);

    expect(serviceCategoryForVendorCategory('restaurant')).toBe('food');
    expect(serviceCategoryForVendorCategory('grocery')).toBe('shops');
    expect(serviceCategoryForVendorCategory('pharmacy')).toBe('pharmacy');
    expect(serviceCategoryForVendorCategory('retail')).toBe('shops');
    expect(serviceCategoryForVendorCategory('market')).toBe('local_market');
    expect(serviceCategoryForVendorCategory('unknown')).toBeNull();
  });

  it('rejects invented identifiers', () => {
    expect(isServiceCategoryId('groceries')).toBe(false);
    expect(isServiceCategoryId('delivery')).toBe(false);
    expect(isServiceCategoryId(null)).toBe(false);
    expect(isLegacyVendorCategory('declutter')).toBe(false);
  });
});
