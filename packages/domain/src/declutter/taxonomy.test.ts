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
    expect(required).toEqual(['phones-tablets', 'computers-laptops', 'electronics']);
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
    expect(categoryByKey('vehicles')).toBeNull();
    expect(publicAttributesFor('vehicles')).toEqual([]);
    expect(publicAttributes('vehicles', { anything: 1 })).toEqual({});
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
