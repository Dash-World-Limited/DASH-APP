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

  it('treats a storage key as no image, rather than a broken request', () => {
    // Nothing resolves keys yet. Returning a URL that 404s would put a broken
    // image in front of a customer; returning null lets the component decide.
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
