/**
 * Catalogue images come from two places, and must keep doing so.
 *
 * Sample and Declutter data hold real HTTPS URLs so the app looks like itself
 * today; the eventual storage pipeline will hold opaque keys. The resolver
 * discriminates on the value rather than on a flag, which is what lets both
 * coexist — and what stops seeded data needing migration on the day uploads
 * land.
 */

import { describe, expect, it } from 'vitest';

import { imageUrl, isDirectImageUrl } from './images';

describe('imageUrl', () => {
  it('renders a stored URL directly', () => {
    expect(imageUrl('https://images.example.com/sofa.jpg')).toBe(
      'https://images.example.com/sofa.jpg',
    );
    expect(imageUrl('http://images.example.com/sofa.jpg')).toBe(
      'http://images.example.com/sofa.jpg',
    );
  });

  it('renders a signed local API image URL', () => {
    expect(
      imageUrl('/v1/files/vendor-products%2Fabc?expires=123&signature=deadbeef'),
    ).toBe('/v1/files/vendor-products%2Fabc?expires=123&signature=deadbeef');
  });

  it('treats a raw storage key as no image, rather than a broken request', () => {
    expect(imageUrl('vendors/iya-kemi/jollof.jpg')).toBeNull();
  });

  it('handles absence in all its forms', () => {
    expect(imageUrl(null)).toBeNull();
    expect(imageUrl(undefined)).toBeNull();
    expect(imageUrl('')).toBeNull();
  });

  it('does not mistake a key that merely mentions http for a URL', () => {
    expect(isDirectImageUrl('vendors/http-cables/cable.jpg')).toBe(false);
    expect(imageUrl('vendors/http-cables/cable.jpg')).toBeNull();
  });
});
