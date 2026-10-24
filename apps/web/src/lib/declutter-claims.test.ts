import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BADGE_LABELS, BADGE_MEANINGS, TRUST_PROMISES } from './declutter';

/**
 * What the Declutters website is allowed to claim about an item.
 *
 * DASH reviews a listing — its photos, description and price — and checks the
 * seller's identity. It never handles the item: inspection is arranged between
 * buyer and seller, and the published Terms tell the buyer to inspect before
 * paying. A page that says DASH inspected the item contradicts those Terms and
 * tells a stranger something false about a second-hand thing they are about to
 * pay for, so these tests pin the wording.
 */

// "DASH inspected this", "we inspect every item", "inspected by DASH" — any
// claim that DASH physically examined the item or verified its condition.
const INSPECTION_CLAIM =
  /\b(DASH|we)\b[^.]{0,30}\binspect(s|ed)?\b|\binspected by\b|\b(verified|certified) condition\b|\bcondition (is )?(verified|certified)\b/i;

function sourcesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourcesUnder(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

describe('Declutters trust claims', () => {
  it('the promises describe a review of the listing, not an inspection of the item', () => {
    for (const promise of TRUST_PROMISES) {
      expect(promise.body, promise.title).not.toMatch(INSPECTION_CLAIM);
    }
    const reviewed = TRUST_PROMISES.find((promise) => promise.title === 'DASH Reviewed');
    expect(reviewed?.body).toMatch(/condition is as described by the seller/i);
  });

  it('every badge has an explanation, and none claims an inspection', () => {
    expect(Object.keys(BADGE_MEANINGS).sort()).toEqual(Object.keys(BADGE_LABELS).sort());
    for (const [badge, meaning] of Object.entries(BADGE_MEANINGS)) {
      expect(meaning, badge).not.toMatch(INSPECTION_CLAIM);
    }
  });

  it('no Declutters page or component says DASH inspected the item', () => {
    const root = join(__dirname, '..');
    const files = [
      ...sourcesUnder(join(root, 'app', '(declutter)')),
      ...sourcesUnder(join(root, 'components', 'declutter')),
    ];
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      // Comments are allowed to discuss inspection; rendered text is not
      // allowed to claim it. Strip comments before looking.
      const rendered = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(rendered, file).not.toMatch(INSPECTION_CLAIM);
    }
  });

  it('the pattern does catch the sentences it exists to stop', () => {
    for (const claim of [
      'DASH inspected this item and set the price.',
      'We inspect every item before it goes live.',
      'Inspected by DASH.',
      'Verified condition',
    ]) {
      expect(claim).toMatch(INSPECTION_CLAIM);
    }
    // And leaves honest sentences alone.
    expect('Condition, collection or inspection. The price is fixed.').not.toMatch(INSPECTION_CLAIM);
    expect('Inspect anything before you pay for it.').not.toMatch(INSPECTION_CLAIM);
  });
});
