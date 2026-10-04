import { describe, expect, it } from 'vitest';
import {
  attributeSchemaJson,
  categoryByKey,
  DECLUTTER_CATEGORIES,
  DECLUTTER_LOCATIONS,
  isListableLocation,
  LISTABLE_LOCATIONS,
  publicAreaLabel,
  publicAttributes,
  publicAttributesFor,
  publicLocation,
  stateOf,
} from './index.js';

describe('geography', () => {
  it('gives every location a unique slug', () => {
    const slugs = DECLUTTER_LOCATIONS.map((l) => l.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('resolves every parent that is named', () => {
    const slugs = new Set(DECLUTTER_LOCATIONS.map((l) => l.slug));
    for (const location of DECLUTTER_LOCATIONS) {
      if (location.parentSlug !== null) {
        expect(slugs.has(location.parentSlug), `${location.slug} → ${location.parentSlug}`).toBe(
          true,
        );
      }
    }
  });

  it('declares parents before children', () => {
    // The seed walks this list once and expects a parent's id to be known by
    // the time a child needs it. That is a property of the ordering, so it is
    // asserted here rather than trusted there.
    const seen = new Set<string>();
    for (const location of DECLUTTER_LOCATIONS) {
      if (location.parentSlug !== null) {
        expect(seen.has(location.parentSlug), `${location.slug} precedes its parent`).toBe(true);
      }
      seen.add(location.slug);
    }
  });

  it('roots every location at a state', () => {
    for (const location of DECLUTTER_LOCATIONS) {
      expect(stateOf(location.slug), location.slug).not.toBeNull();
    }
  });

  it('only lets listings attach to an area', () => {
    expect(isListableLocation('area')).toBe(true);
    expect(isListableLocation('state')).toBe(false);
    expect(isListableLocation('lga')).toBe(false);
    for (const location of LISTABLE_LOCATIONS) {
      expect(location.kind).toBe('area');
    }
  });

  it('covers exactly the V1 launch geography', () => {
    const states = DECLUTTER_LOCATIONS.filter((l) => l.kind === 'state').map((l) => l.name);
    expect(states).toEqual(['Lagos', 'Delta']);
    // Delta is Asaba and nothing else: DASH is not open across the state.
    const deltaAreas = LISTABLE_LOCATIONS.filter((l) => stateOf(l.slug)?.slug === 'delta');
    expect(deltaAreas.map((l) => l.name)).toEqual(['Asaba']);
  });

  it('labels an area the way a person would say it', () => {
    expect(publicAreaLabel('lagos-lekki')).toBe('Lekki, Lagos');
    expect(publicAreaLabel('lagos-yaba')).toBe('Yaba, Lagos');
    expect(publicAreaLabel('delta-asaba')).toBe('Asaba, Delta');
    // Not "Lekki, Eti-Osa, Lagos" — that is an address, not a place.
    expect(publicAreaLabel('lagos-lekki')).not.toContain('Eti-Osa');
  });

  it('returns nothing for a location it does not know', () => {
    expect(publicAreaLabel('lagos-nowhere')).toBeNull();
    expect(publicLocation('lagos-nowhere')).toBeNull();
  });

  it('publishes a slug and a label and nothing else', () => {
    // The privacy rule, asserted structurally: no coordinate, no address, no
    // distance and no delivery estimate can ride along on a public location.
    const location = publicLocation('lagos-lekki');
    expect(location).not.toBeNull();
    expect(Object.keys(location!).sort()).toEqual(['label', 'slug']);
  });

  it('holds no coordinates anywhere in the definitions', () => {
    const forbidden = ['lat', 'lng', 'longitude', 'latitude', 'radius', 'eta', 'distance'];
    for (const location of DECLUTTER_LOCATIONS) {
      for (const key of Object.keys(location)) {
        expect(forbidden).not.toContain(key.toLowerCase());
      }
    }
  });
});

describe('categories', () => {
  it('keeps keys and slugs unique', () => {
    const keys = DECLUTTER_CATEGORIES.map((c) => c.key);
    const slugs = DECLUTTER_CATEGORIES.map((c) => c.slug);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('uses url-safe, stable identifiers', () => {
    for (const category of DECLUTTER_CATEGORIES) {
      expect(category.key, category.key).toMatch(/^[a-z0-9-]+$/);
      expect(category.slug, category.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('stays small enough to be usable', () => {
    // A taxonomy nobody can hold in their head gets mis-filed. If this needs
    // raising, raise it deliberately.
    expect(DECLUTTER_CATEGORIES.length).toBeLessThanOrEqual(12);
    expect(DECLUTTER_CATEGORIES.length).toBeGreaterThanOrEqual(6);
  });

  it('gives every category at least one attribute, with unique keys', () => {
    for (const category of DECLUTTER_CATEGORIES) {
      expect(category.attributes.length, category.key).toBeGreaterThan(0);
      const keys = category.attributes.map((a) => a.key);
      expect(new Set(keys).size, category.key).toBe(keys.length);
    }
  });

  it('does not force one category’s fields onto another', () => {
    const furniture = publicAttributesFor('home-furniture').map((a) => a.key);
    expect(furniture).not.toContain('batteryHealthPercent');
    expect(furniture).not.toContain('storageGb');

    const phones = publicAttributesFor('phones-tablets').map((a) => a.key);
    expect(phones).toContain('storageGb');
    expect(phones).not.toContain('seats');
  });

  it('never publishes ownership evidence', () => {
    // An IMEI or serial is collected so DASH can check it. Publishing one
    // hands a thief what they need to clone a handset.
    for (const category of DECLUTTER_CATEGORIES) {
      const published = publicAttributesFor(category.key).map((a) => a.key);
      expect(published, category.key).not.toContain('imei');
      expect(published, category.key).not.toContain('serialNumber');
    }
    const admin = categoryByKey('phones-tablets')!.attributes.filter(
      (a) => a.visibility === 'admin',
    );
    expect(admin.map((a) => a.key)).toEqual(['imei', 'serialNumber']);
  });

  it('expects ownership evidence for the things worth stealing', () => {
    const required = DECLUTTER_CATEGORIES.filter((c) => c.requiresOwnershipEvidence).map(
      (c) => c.key,
    );
    expect(required).toEqual([
      'phones-tablets',
      'computers-laptops',
      'electronics',
      'power-tools',
      'cars-vehicles',
    ]);
  });

  it('filters stored attributes down to an allowlist', () => {
    const stored = {
      storageGb: 128,
      imei: '350000000000000',
      somethingNobodyDeclared: 'x',
    };
    const published = publicAttributes('phones-tablets', stored);
    expect(published).toEqual({ storageGb: 128 });
    // Dropped rather than passed through: an unknown key from an import or an
    // older form must not surface on a public page.
    expect(published).not.toHaveProperty('somethingNobodyDeclared');
    expect(published).not.toHaveProperty('imei');
  });

  it('returns nothing for a category it does not know', () => {
    expect(categoryByKey('yachts')).toBeNull();
    expect(publicAttributesFor('yachts')).toEqual([]);
    expect(publicAttributes('yachts', { anything: 1 })).toEqual({});
  });

  it('serialises an attribute schema that round-trips', () => {
    for (const category of DECLUTTER_CATEGORIES) {
      expect(JSON.parse(attributeSchemaJson(category))).toEqual(category.attributes);
    }
  });

  it('gives every select field its options', () => {
    for (const category of DECLUTTER_CATEGORIES) {
      for (const field of category.attributes) {
        if (field.type === 'select') {
          expect(field.options?.length, `${category.key}.${field.key}`).toBeGreaterThan(1);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Cars & Vehicles
// ---------------------------------------------------------------------------

describe('cars are a marketplace category, not a delivery one', () => {
  const cars = categoryByKey('cars-vehicles')!;

  it('exists as a top-level category', () => {
    expect(cars).not.toBeNull();
    expect(cars.name).toBe('Cars & Vehicles');
  });

  it('is never eligible for DASH logistics', () => {
    // The load-bearing test of this category. A car cannot be put on a
    // motorcycle, and its ownership moves by title transfer at an agreed place
    // rather than by a handover at a door. Anything that later decides what to
    // dispatch has to read this field, which is what stops a Toyota entering a
    // rider queue.
    expect(cars.handover).toBe('direct_only');
  });

  it('leaves every other category eligible, so this is a property of cars', () => {
    for (const category of DECLUTTER_CATEGORIES) {
      if (category.key === 'cars-vehicles') continue;
      expect(category.handover, category.key).toBe('dash_logistics_eligible');
    }
  });

  it('never publishes a VIN, an engine number, a plate or a title document', () => {
    // Exactly the reasoning behind hiding an IMEI, and higher stakes. A
    // published VIN is what somebody needs to clone plates, forge papers or
    // contest a stolen-vehicle report.
    const published = publicAttributesFor('cars-vehicles').map((a) => a.key);
    for (const secret of ['vin', 'engineNumber', 'plateNumber', 'titleDocument', 'customsDocument']) {
      expect(published, secret).not.toContain(secret);
    }
  });

  it('drops those identifiers from stored attributes too', () => {
    const published = publicAttributes('cars-vehicles', {
      make: 'Toyota',
      model: 'Corolla',
      year: 2016,
      vin: 'JTDBR32E160123456',
      plateNumber: 'LSD123XY',
      titleDocument: 'CoO/2016/44120',
    });
    expect(published).toEqual({ make: 'Toyota', model: 'Corolla', year: 2016 });
  });

  it('publishes what a buyer needs to decide whether to travel to see it', () => {
    const published = publicAttributesFor('cars-vehicles').map((a) => a.key);
    for (const field of [
      'make',
      'model',
      'year',
      'mileageKm',
      'transmission',
      'fuelType',
      'accidentHistory',
      'mechanicalCondition',
    ]) {
      expect(published, field).toContain(field);
    }
  });

  it('requires the facts a car cannot be listed honestly without', () => {
    const required = cars.attributes.filter((a) => a.required).map((a) => a.key);
    expect(required).toEqual(
      expect.arrayContaining([
        'make',
        'model',
        'year',
        'mileageKm',
        'transmission',
        'fuelType',
        'accidentHistory',
        'mechanicalCondition',
      ]),
    );
  });

  it('needs ownership evidence before it can be published', () => {
    expect(cars.requiresOwnershipEvidence).toBe(true);
  });
});
