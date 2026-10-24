/**
 * Five sections, one state machine, five ways of saying the same thing.
 *
 * `preparing` is a kitchen word and it was being shown to someone buying a
 * washing machine. These assert that each section reads correctly *and* that
 * the vocabulary is only vocabulary — the same internal states still drive
 * dispatch, so nothing here can quietly become a second state machine.
 */

import { describe, expect, it } from 'vitest';

import { ORDER_STATUSES, type OrderStatus } from './index.js';
import {
  customerLabel,
  customerTimeline,
  vendorStartActionLabel,
  vendorStatusLabel,
  verticalOf,
} from './vocabulary.js';

const SECTIONS = {
  restaurant: 'restaurants',
  grocery: 'shops',
  retail: 'shops',
  pharmacy: 'pharmacy',
  market: 'market',
  declutter: 'declutter',
} as const;

describe('what each section calls "preparing"', () => {
  it('says the right thing to every customer', () => {
    expect(customerLabel('preparing', 'restaurant')).toBe('Preparing your order');
    expect(customerLabel('preparing', 'grocery')).toBe('Picking & packing');
    expect(customerLabel('preparing', 'retail')).toBe('Picking & packing');
    expect(customerLabel('preparing', 'pharmacy')).toBe('Processing your order');
    expect(customerLabel('preparing', 'market')).toBe('Sourcing your items');
  });

  it('never tells a pharmacy customer their medicine is being prepared', () => {
    // "Preparing" implies compounding — making up a preparation — which is a
    // regulated activity DASH does not perform and must not appear to.
    const label = customerLabel('preparing', 'pharmacy');
    expect(label.toLowerCase()).not.toContain('prepar');
    expect(label.toLowerCase()).not.toContain('medicine');
  });

  it('says nothing restaurant-shaped to a Declutter buyer', () => {
    // Declutter's real lifecycle does not exist yet. Until it does the wording
    // must be neutral: no kitchen language, and equally no claim about
    // inspection, agreement, reservation or self-pickup, none of which the app
    // can carry out today.
    const label = customerLabel('preparing', 'declutter');
    expect(label).toBe('Processing your order');
    for (const word of ['prepar', 'cook', 'inspect', 'reserv', 'agree', 'pickup by you']) {
      expect(label.toLowerCase(), word).not.toContain(word);
    }
  });

  it('falls back to the most general wording, never the most specific', () => {
    // An unknown category reading as "restaurant" is how "Being prepared"
    // reached a furniture buyer in the first place.
    for (const unknown of [null, undefined, '', 'something_new']) {
      expect(customerLabel('preparing', unknown), String(unknown)).toBe('Picking & packing');
    }
  });
});

describe('the sections converge once the rider is involved', () => {
  it('says the same thing to everyone from pickup onwards', () => {
    // Below `ready` it is the same job in every section, so diverging would be
    // decoration rather than information.
    const shared: OrderStatus[] = [
      'rider_assigned',
      'rider_arrived',
      'picked_up',
      'en_route',
      'arrived',
      'delivered',
    ];
    for (const status of shared) {
      const labels = Object.keys(SECTIONS).map((category) => customerLabel(status, category));
      expect(new Set(labels).size, status).toBe(1);
    }
  });

  it('uses no vendor-type language in the shared half', () => {
    // These strings are read by someone tracking a sofa and someone tracking
    // soup. "Rider on the way to the restaurant" would be wrong for both.
    for (const status of ['rider_assigned', 'rider_arrived'] as OrderStatus[]) {
      const label = customerLabel(status, 'restaurant').toLowerCase();
      expect(label, status).not.toContain('restaurant');
      expect(label, status).not.toContain('kitchen');
    }
  });
});

describe('every status has words, in every section', () => {
  it('never returns an empty or internal-looking label', () => {
    // The vendor console used to print `status.replace(/_/g, ' ')`, so
    // merchants read "vendor reviewing" and "rider assigned". No label may
    // look like a schema field again.
    for (const category of Object.keys(SECTIONS)) {
      for (const status of ORDER_STATUSES) {
        const customer = customerLabel(status, category);
        const vendor = vendorStatusLabel(status, category);
        for (const [name, label] of [
          ['customer', customer],
          ['vendor', vendor],
        ] as const) {
          expect(label.length, `${name} ${status} ${category}`).toBeGreaterThan(2);
          expect(label, `${name} ${status} ${category}`).not.toContain('_');
          expect(label, `${name} ${status} ${category}`).not.toBe(status);
        }
      }
    }
  });
});

describe('the verb that commits a merchant', () => {
  it('describes the work each section actually does', () => {
    expect(vendorStartActionLabel('restaurant')).toBe('Start preparing');
    expect(vendorStartActionLabel('grocery')).toBe('Start picking');
    expect(vendorStartActionLabel('retail')).toBe('Start picking');
    expect(vendorStartActionLabel('market')).toBe('Start sourcing');
    expect(vendorStartActionLabel('pharmacy')).toBe('Process order');
    expect(vendorStartActionLabel('declutter')).toBe('Process order');
  });

  it('does not ask a pharmacist to start preparing', () => {
    expect(vendorStartActionLabel('pharmacy').toLowerCase()).not.toContain('prepar');
  });
});

describe('the customer timeline', () => {
  it('keeps the same shape for every section', () => {
    // The phases are structural — the tracking screen renders four steps
    // whatever is being delivered. Only the words change.
    for (const category of Object.keys(SECTIONS)) {
      const steps = customerTimeline(category);
      expect(steps.map((s) => s.key), category).toEqual([
        'confirming',
        'preparing',
        'on_the_way',
        'complete',
      ]);
    }
  });

  it('words the middle step per section', () => {
    const wordFor = (category: string): string =>
      customerTimeline(category).find((s) => s.key === 'preparing')?.label ?? '';

    expect(wordFor('restaurant')).toBe('Preparing');
    expect(wordFor('grocery')).toBe('Picking');
    expect(wordFor('pharmacy')).toBe('Processing');
    expect(wordFor('market')).toBe('Sourcing');
    expect(wordFor('declutter')).toBe('Processing');
  });
});

describe('vocabulary is only vocabulary', () => {
  it('groups the six backend categories into five customer sections', () => {
    for (const [category, vertical] of Object.entries(SECTIONS)) {
      expect(verticalOf(category), category).toBe(vertical);
    }
  });

  it('does not touch the state machine', () => {
    // The guarantee this whole change rests on. `preparing` is still one
    // status with one name, and it is still what dispatch is bound to — five
    // labels for it, one state.
    expect(ORDER_STATUSES).toContain('preparing');
    expect(ORDER_STATUSES.filter((s) => s === 'preparing')).toHaveLength(1);

    const labels = Object.keys(SECTIONS).map((c) => customerLabel('preparing', c));
    expect(new Set(labels).size).toBeGreaterThan(1);
  });
});
