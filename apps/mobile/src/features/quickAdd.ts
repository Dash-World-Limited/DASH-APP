/**
 * What the plus on a product card may do.
 *
 * A product with a real choice to make — two colours, three storage sizes —
 * cannot be added from the grid, because adding it would choose for the
 * customer, and in a real catalogue the choice changes the price (modifier
 * groups carry a price delta). So the plus opens the product instead. A product
 * with nothing to choose, or only single-option groups, is added directly with
 * those options filled in.
 *
 * Pure: tested directly.
 */

import type { ProductModel } from '../data/models';

export type QuickAddPlan =
  | { kind: 'add'; options: Record<string, string> }
  | { kind: 'choose' };

export function quickAddPlan(product: Pick<ProductModel, 'optionGroups'>): QuickAddPlan {
  if (product.optionGroups.some((group) => group.options.length > 1)) return { kind: 'choose' };
  const options: Record<string, string> = {};
  for (const group of product.optionGroups) {
    const only = group.options[0];
    if (only) options[group.id] = only.id;
  }
  return { kind: 'add', options };
}
