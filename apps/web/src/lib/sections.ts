'use client';

/**
 * The five things DASH sells, and how each maps onto the catalogue.
 *
 * DASH is one marketplace with five equal front doors, not a food app with
 * extras bolted on. Every section behaves identically — pick a section, pick a
 * seller, browse that seller's own categories, add to basket — so there is one
 * pattern to learn and one code path to maintain. What differs between them is
 * a label and a `Vendor.category` filter, which is the whole reason this is a
 * table rather than five hand-built screens.
 *
 * `categories` is a list because a section is a customer-facing idea and the
 * column is a business type: a supermarket and a hardware shop are both Shops
 * to someone doing their errands, while the backend keeps `grocery` and
 * `retail` distinct because commission, licensing and reporting differ. The
 * grouping happens here and nowhere else.
 */

/**
 * The five front doors, as a closed set.
 *
 * A union rather than `string` so that anything keyed by section — a mark, a
 * tint, a vocabulary — is exhaustive at compile time. Adding a sixth door
 * becomes a type error everywhere it has to be accounted for, which is the
 * moment to ask whether there should be one.
 */
export type SectionSlug = 'shops' | 'restaurants' | 'market' | 'pharmacy' | 'declutter';

export interface Section {
  /** Route segment and lookup key. */
  slug: SectionSlug;
  label: string;
  /** One line, shown under the heading on the section page. */
  blurb: string;
  /** The `Vendor.category` values this section gathers. */
  categories: string[];
}

export const SECTIONS: Section[] = [
  {
    slug: 'shops',
    label: 'Shops',
    blurb: 'Supermarkets, electronics, fashion, beauty and home.',
    // A supermarket is a shop to a customer; the backend keeps `grocery` and
    // `retail` separate for commission and reporting, and that stays true.
    categories: ['retail', 'grocery'],
  },
  {
    slug: 'restaurants',
    label: 'Restaurants',
    blurb: 'Hot food from kitchens near you.',
    categories: ['restaurant'],
  },
  {
    slug: 'market',
    label: 'Local Market',
    blurb: 'Fresh produce and staples from market traders.',
    categories: ['market'],
  },
  {
    slug: 'pharmacy',
    label: 'Pharmacy',
    blurb: 'Approved pharmacies for everyday health needs.',
    categories: ['pharmacy'],
  },
  {
    slug: 'declutter',
    label: 'Declutter',
    blurb: 'Curated second-hand from trusted sellers.',
    categories: ['declutter'],
  },
];

export function sectionBySlug(slug: string): Section | undefined {
  return SECTIONS.find((section) => section.slug === slug);
}
