/**
 * DASH World Declutters — the V1 geography and category taxonomy.
 *
 * Reference data, defined here as typed constants rather than written straight
 * into the seed, for three reasons. It can be tested without a database. The
 * API and the admin console can read the same definitions the seed wrote, so a
 * category's fields cannot drift from what was stored. And the rules about what
 * is *public* — which is most of the privacy surface of a marketplace — live
 * beside the data they govern instead of in whichever route remembered.
 *
 * ## Geography
 *
 * `state → lga → area`, and a listing attaches to an **area**. That is the
 * whole hierarchy V1 needs, and it extends downward or sideways by adding rows
 * rather than columns: another state is a row, another LGA is a row, and the
 * day DASH lists in Port Harcourt nothing here changes shape.
 *
 * What is deliberately absent is as important. There are no coordinates, no
 * radius, no distance and no delivery estimate anywhere in this module. A
 * marketplace listing says "Lekki, Lagos" and stops. Coordinates will exist
 * internally later for inspection routing and serviceability, and they will not
 * come from here — `publicLocation()` returns a slug and a label and has no way
 * to return anything else.
 *
 * ## Categories
 *
 * Nine, chosen for what people in Lagos and Asaba actually resell rather than
 * for completeness. Each carries its own attribute fields, because a phone has
 * a battery and storage and a sofa has neither, and a single shared attribute
 * list would put `batteryHealthPercent` on furniture.
 *
 * Keys and slugs are stable identifiers. Labels may be reworded freely; the key
 * is what a listing and a URL hold, so renaming "Home & Furniture" tomorrow
 * breaks nothing.
 */

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------

export type LocationKind = 'state' | 'lga' | 'area';

export interface LocationDefinition {
  /** Stable identifier. State-prefixed so two "GRA"s never collide. */
  readonly slug: string;
  readonly name: string;
  readonly kind: LocationKind;
  readonly parentSlug: string | null;
  readonly sortOrder: number;
}

/**
 * V1 marketplace geography: Lagos State, and Asaba in Delta State.
 *
 * Ordered parents-first so a seed can walk it once and always find a parent
 * already written. Asaba is an `area` under Oshimili South rather than a city
 * of its own, which keeps one rule for the whole country — a listing attaches
 * to an area, and an area's public label is "Area, State".
 *
 * The Lagos areas are the ones second-hand goods actually move in. This is not
 * a gazetteer and should not become one; an area nobody lists in is a filter
 * that always returns nothing.
 */
export const DECLUTTER_LOCATIONS: readonly LocationDefinition[] = [
  // --- Lagos State -------------------------------------------------------
  { slug: 'lagos', name: 'Lagos', kind: 'state', parentSlug: null, sortOrder: 1 },

  { slug: 'lagos-eti-osa', name: 'Eti-Osa', kind: 'lga', parentSlug: 'lagos', sortOrder: 1 },
  { slug: 'lagos-lekki', name: 'Lekki', kind: 'area', parentSlug: 'lagos-eti-osa', sortOrder: 1 },
  { slug: 'lagos-victoria-island', name: 'Victoria Island', kind: 'area', parentSlug: 'lagos-eti-osa', sortOrder: 2 },
  { slug: 'lagos-ikoyi', name: 'Ikoyi', kind: 'area', parentSlug: 'lagos-eti-osa', sortOrder: 3 },
  { slug: 'lagos-ajah', name: 'Ajah', kind: 'area', parentSlug: 'lagos-eti-osa', sortOrder: 4 },

  { slug: 'lagos-mainland', name: 'Lagos Mainland', kind: 'lga', parentSlug: 'lagos', sortOrder: 2 },
  { slug: 'lagos-yaba', name: 'Yaba', kind: 'area', parentSlug: 'lagos-mainland', sortOrder: 1 },
  { slug: 'lagos-ebute-metta', name: 'Ebute Metta', kind: 'area', parentSlug: 'lagos-mainland', sortOrder: 2 },

  { slug: 'lagos-ikeja', name: 'Ikeja', kind: 'lga', parentSlug: 'lagos', sortOrder: 3 },
  { slug: 'lagos-ikeja-gra', name: 'Ikeja GRA', kind: 'area', parentSlug: 'lagos-ikeja', sortOrder: 1 },
  { slug: 'lagos-maryland', name: 'Maryland', kind: 'area', parentSlug: 'lagos-ikeja', sortOrder: 2 },
  { slug: 'lagos-opebi', name: 'Opebi', kind: 'area', parentSlug: 'lagos-ikeja', sortOrder: 3 },

  { slug: 'lagos-surulere-lga', name: 'Surulere', kind: 'lga', parentSlug: 'lagos', sortOrder: 4 },
  { slug: 'lagos-surulere', name: 'Surulere', kind: 'area', parentSlug: 'lagos-surulere-lga', sortOrder: 1 },

  { slug: 'lagos-kosofe', name: 'Kosofe', kind: 'lga', parentSlug: 'lagos', sortOrder: 5 },
  { slug: 'lagos-gbagada', name: 'Gbagada', kind: 'area', parentSlug: 'lagos-kosofe', sortOrder: 1 },
  { slug: 'lagos-magodo', name: 'Magodo', kind: 'area', parentSlug: 'lagos-kosofe', sortOrder: 2 },

  { slug: 'lagos-amuwo-odofin', name: 'Amuwo-Odofin', kind: 'lga', parentSlug: 'lagos', sortOrder: 6 },
  { slug: 'lagos-festac', name: 'Festac', kind: 'area', parentSlug: 'lagos-amuwo-odofin', sortOrder: 1 },

  // --- Delta State -------------------------------------------------------
  { slug: 'delta', name: 'Delta', kind: 'state', parentSlug: null, sortOrder: 2 },

  { slug: 'delta-oshimili-south', name: 'Oshimili South', kind: 'lga', parentSlug: 'delta', sortOrder: 1 },
  { slug: 'delta-asaba', name: 'Asaba', kind: 'area', parentSlug: 'delta-oshimili-south', sortOrder: 1 },
];

const BY_SLUG: ReadonlyMap<string, LocationDefinition> = new Map(
  DECLUTTER_LOCATIONS.map((location) => [location.slug, location]),
);

/** Only areas hold listings. States and LGAs are structure, not destinations. */
export function isListableLocation(kind: LocationKind): boolean {
  return kind === 'area';
}

/** Every area a listing may currently be placed in. */
export const LISTABLE_LOCATIONS: readonly LocationDefinition[] = DECLUTTER_LOCATIONS.filter(
  (location) => isListableLocation(location.kind),
);

/** Walk up to the state a location sits in. */
export function stateOf(slug: string): LocationDefinition | null {
  let current = BY_SLUG.get(slug) ?? null;
  while (current && current.kind !== 'state') {
    current = current.parentSlug ? (BY_SLUG.get(current.parentSlug) ?? null) : null;
  }
  return current;
}

/**
 * What a buyer is shown: "Lekki, Lagos", "Asaba, Delta".
 *
 * Area and state, and nothing between them — "Lekki, Eti-Osa, Lagos" is how an
 * address is written, not how a person says where something is.
 */
export function publicAreaLabel(slug: string): string | null {
  const location = BY_SLUG.get(slug);
  if (!location) return null;
  const state = stateOf(slug);
  if (!state) return location.name;
  if (location.slug === state.slug) return state.name;
  return `${location.name}, ${state.name}`;
}

/** Exactly what a public listing may say about where something is. */
export interface PublicLocation {
  readonly slug: string;
  readonly label: string;
}

/**
 * Narrow a location to its public shape.
 *
 * The return type is the point. There is no coordinate, no address, no
 * distance and no delivery estimate on `PublicLocation`, so a marketplace
 * response cannot carry one by accident — a route would have to add the field
 * deliberately, and a reviewer would see it.
 */
export function publicLocation(slug: string): PublicLocation | null {
  const label = publicAreaLabel(slug);
  if (label === null) return null;
  return { slug, label };
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export type AttributeType = 'text' | 'number' | 'select' | 'boolean';

export interface AttributeField {
  /** Stable key stored on the listing's attributes JSON. */
  readonly key: string;
  readonly label: string;
  readonly type: AttributeType;
  readonly unit?: string;
  readonly required?: boolean;
  readonly options?: readonly string[];
  /**
   * `admin` fields are collected during intake and never rendered publicly.
   *
   * An IMEI or a serial number is ownership evidence, and publishing one hands
   * a thief everything they need to clone a handset or contest a blacklisting.
   * They are gathered precisely so DASH can check them, and for no other
   * reason.
   */
  readonly visibility: 'public' | 'admin';
}

export interface CategoryDefinition {
  /** Stable identifier. Never rename; labels are free to change. */
  readonly key: string;
  readonly name: string;
  readonly slug: string;
  readonly sortOrder: number;
  /**
   * Whether an admin should see proof of ownership before this is published.
   * True for the categories that are worth stealing and easy to move.
   */
  readonly requiresOwnershipEvidence: boolean;
  readonly attributes: readonly AttributeField[];
}

const CONDITION_NOTE_FIELDS: readonly AttributeField[] = [
  { key: 'brand', label: 'Brand', type: 'text', required: true, visibility: 'public' },
  { key: 'model', label: 'Model', type: 'text', visibility: 'public' },
];

/**
 * Nine categories.
 *
 * Vehicles is deliberately absent — see the note in the seed checkpoint. A car
 * cannot be carried by a DASH rider, needs title transfer rather than a
 * handover, and its inspection is a different product. Adding it later is a
 * row in this table plus a decision about fulfilment, and pretending otherwise
 * now would put listings in the marketplace that nothing downstream can serve.
 */
export const DECLUTTER_CATEGORIES: readonly CategoryDefinition[] = [
  {
    key: 'phones-tablets',
    name: 'Phones & Tablets',
    slug: 'phones-tablets',
    sortOrder: 1,
    requiresOwnershipEvidence: true,
    attributes: [
      ...CONDITION_NOTE_FIELDS,
      { key: 'storageGb', label: 'Storage', type: 'number', unit: 'GB', required: true, visibility: 'public' },
      { key: 'colour', label: 'Colour', type: 'text', visibility: 'public' },
      { key: 'batteryHealthPercent', label: 'Battery health', type: 'number', unit: '%', visibility: 'public' },
      {
        key: 'networkStatus',
        label: 'Network',
        type: 'select',
        options: ['Unlocked', 'Locked to a network'],
        visibility: 'public',
      },
      { key: 'accessories', label: 'Included accessories', type: 'text', visibility: 'public' },
      { key: 'imei', label: 'IMEI', type: 'text', visibility: 'admin' },
      { key: 'serialNumber', label: 'Serial number', type: 'text', visibility: 'admin' },
    ],
  },
  {
    key: 'computers-laptops',
    name: 'Computers & Laptops',
    slug: 'computers-laptops',
    sortOrder: 2,
    requiresOwnershipEvidence: true,
    attributes: [
      ...CONDITION_NOTE_FIELDS,
      { key: 'processor', label: 'Processor', type: 'text', visibility: 'public' },
      { key: 'ramGb', label: 'RAM', type: 'number', unit: 'GB', visibility: 'public' },
      { key: 'storageGb', label: 'Storage', type: 'number', unit: 'GB', visibility: 'public' },
      {
        key: 'storageType',
        label: 'Storage type',
        type: 'select',
        options: ['SSD', 'HDD', 'SSD + HDD'],
        visibility: 'public',
      },
      { key: 'screenSizeInches', label: 'Screen size', type: 'number', unit: 'in', visibility: 'public' },
      { key: 'graphics', label: 'Graphics', type: 'text', visibility: 'public' },
      { key: 'batteryHealthPercent', label: 'Battery health', type: 'number', unit: '%', visibility: 'public' },
      { key: 'serialNumber', label: 'Serial number', type: 'text', visibility: 'admin' },
    ],
  },
  {
    key: 'electronics',
    name: 'Electronics',
    slug: 'electronics',
    sortOrder: 3,
    requiresOwnershipEvidence: true,
    attributes: [
      ...CONDITION_NOTE_FIELDS,
      {
        key: 'type',
        label: 'Type',
        type: 'select',
        options: ['Television', 'Audio', 'Camera', 'Gaming console', 'Accessory', 'Other'],
        required: true,
        visibility: 'public',
      },
      { key: 'screenSizeInches', label: 'Screen size', type: 'number', unit: 'in', visibility: 'public' },
      { key: 'accessories', label: 'Included accessories', type: 'text', visibility: 'public' },
      { key: 'serialNumber', label: 'Serial number', type: 'text', visibility: 'admin' },
    ],
  },
  {
    key: 'home-furniture',
    name: 'Home & Furniture',
    slug: 'home-furniture',
    sortOrder: 4,
    requiresOwnershipEvidence: false,
    attributes: [
      {
        key: 'type',
        label: 'Type',
        type: 'select',
        options: ['Sofa', 'Bed', 'Wardrobe', 'Table', 'Chair', 'Shelving', 'Decor', 'Other'],
        required: true,
        visibility: 'public',
      },
      { key: 'material', label: 'Material', type: 'text', visibility: 'public' },
      { key: 'colour', label: 'Colour', type: 'text', visibility: 'public' },
      { key: 'dimensions', label: 'Dimensions', type: 'text', visibility: 'public' },
      { key: 'seats', label: 'Seats', type: 'number', visibility: 'public' },
    ],
  },
  {
    key: 'appliances',
    name: 'Appliances',
    slug: 'appliances',
    sortOrder: 5,
    requiresOwnershipEvidence: false,
    attributes: [
      ...CONDITION_NOTE_FIELDS,
      {
        key: 'type',
        label: 'Type',
        type: 'select',
        options: [
          'Fridge or freezer',
          'Washing machine',
          'Cooker or oven',
          'Microwave',
          'Air conditioner',
          'Generator',
          'Other',
        ],
        required: true,
        visibility: 'public',
      },
      { key: 'capacity', label: 'Capacity', type: 'text', visibility: 'public' },
      { key: 'powerRating', label: 'Power rating', type: 'text', visibility: 'public' },
    ],
  },
  {
    key: 'power-tools',
    name: 'Power & Tools',
    slug: 'power-tools',
    sortOrder: 6,
    // Generators are among the most stolen high-value goods in Nigeria, and a
    // serial number is the only thing that distinguishes one from another.
    requiresOwnershipEvidence: true,
    attributes: [
      ...CONDITION_NOTE_FIELDS,
      {
        key: 'type',
        label: 'Type',
        type: 'select',
        options: [
          'Generator',
          'Inverter',
          'Power station',
          'Solar panel',
          'Battery',
          'Power tool',
          'Hand tool',
          'Workshop equipment',
          'Other',
        ],
        required: true,
        visibility: 'public',
      },
      { key: 'powerOutput', label: 'Power output', type: 'text', unit: 'kVA or W', visibility: 'public' },
      {
        key: 'fuelType',
        label: 'Runs on',
        type: 'select',
        options: ['Petrol', 'Diesel', 'Gas', 'Mains electricity', 'Solar', 'Battery'],
        visibility: 'public',
      },
      { key: 'capacity', label: 'Capacity', type: 'text', unit: 'Ah or kWh', visibility: 'public' },
      // Hours run is to a generator what mileage is to a car, and it is the
      // number a buyer most wants and most rarely gets.
      { key: 'hoursUsed', label: 'Hours run', type: 'number', unit: 'hrs', visibility: 'public' },
      { key: 'accessories', label: 'Included accessories', type: 'text', visibility: 'public' },
      { key: 'serialNumber', label: 'Serial number', type: 'text', visibility: 'admin' },
    ],
  },
  {
    key: 'fashion',
    name: 'Fashion',
    slug: 'fashion',
    sortOrder: 7,
    requiresOwnershipEvidence: false,
    attributes: [
      { key: 'brand', label: 'Brand', type: 'text', visibility: 'public' },
      {
        key: 'type',
        label: 'Type',
        type: 'select',
        options: ['Clothing', 'Shoes', 'Bag', 'Watch', 'Jewellery', 'Accessory'],
        required: true,
        visibility: 'public',
      },
      { key: 'size', label: 'Size', type: 'text', visibility: 'public' },
      { key: 'colour', label: 'Colour', type: 'text', visibility: 'public' },
      { key: 'material', label: 'Material', type: 'text', visibility: 'public' },
    ],
  },
  {
    key: 'baby-kids',
    name: 'Baby & Kids',
    slug: 'baby-kids',
    sortOrder: 8,
    requiresOwnershipEvidence: false,
    attributes: [
      { key: 'brand', label: 'Brand', type: 'text', visibility: 'public' },
      {
        key: 'type',
        label: 'Type',
        type: 'select',
        options: ['Pram or stroller', 'Car seat', 'Cot or bed', 'Toy', 'Clothing', 'Other'],
        required: true,
        visibility: 'public',
      },
      { key: 'ageRange', label: 'Suitable age', type: 'text', visibility: 'public' },
    ],
  },
  {
    key: 'sports-outdoors',
    name: 'Sports & Outdoors',
    slug: 'sports-outdoors',
    sortOrder: 9,
    requiresOwnershipEvidence: false,
    attributes: [
      { key: 'brand', label: 'Brand', type: 'text', visibility: 'public' },
      {
        key: 'type',
        label: 'Type',
        type: 'select',
        options: ['Bicycle', 'Gym equipment', 'Outdoor gear', 'Sports equipment', 'Other'],
        required: true,
        visibility: 'public',
      },
      { key: 'size', label: 'Size', type: 'text', visibility: 'public' },
    ],
  },
];

const CATEGORY_BY_KEY: ReadonlyMap<string, CategoryDefinition> = new Map(
  DECLUTTER_CATEGORIES.map((category) => [category.key, category]),
);

export function categoryByKey(key: string): CategoryDefinition | null {
  return CATEGORY_BY_KEY.get(key) ?? null;
}

/** The fields a category shows to the public. Never the admin-only ones. */
export function publicAttributesFor(key: string): readonly AttributeField[] {
  return categoryByKey(key)?.attributes.filter((field) => field.visibility === 'public') ?? [];
}

/**
 * Strip a listing's stored attributes down to what may be published.
 *
 * Allowlist rather than blocklist: an attribute nobody declared is dropped
 * rather than passed through, so a stray key written by an import or an older
 * version of a form cannot surface on a public page.
 */
export function publicAttributes(
  key: string,
  stored: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const allowed = new Set(publicAttributesFor(key).map((field) => field.key));
  const out: Record<string, unknown> = {};
  for (const [attribute, value] of Object.entries(stored)) {
    if (allowed.has(attribute)) out[attribute] = value;
  }
  return out;
}

/** Serialised form stored on DeclutterCategory.attributeSchema. */
export function attributeSchemaJson(category: CategoryDefinition): string {
  return JSON.stringify(category.attributes);
}
