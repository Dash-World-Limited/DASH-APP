/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { parseStudioFeed } from '@dash/domain/content/presentation';
import {
  StudioCategoryArtwork,
  StudioVendorArtwork,
  StudioDiscovery,
} from './StudioPresentation';
const image = { url: 'https://assets.test/image.webp', alt: 'DASH artwork' };
const parse = (items: unknown[]) =>
  parseStudioFeed({ schemaVersion: 1, items }, 'https://api.dash.test');
afterEach(cleanup);
describe('web presentation projections', () => {
  it('overrides only the matching category artwork, then removes a failed image', () => {
    const items = parse([
      {
        id: 'category',
        type: 'category_artwork',
        placement: 'category.artwork',
        title: 'Food',
        categoryId: 'food',
        image,
      },
    ]);
    const { container } = render(
      <StudioCategoryArtwork items={items} categoryId="restaurants" />,
    );
    fireEvent.error(screen.getByAltText('DASH artwork'));
    expect(container.innerHTML).toBe('');
  });
  it('keeps the category appearance unchanged with no artwork', () => {
    const { container } = render(
      <StudioCategoryArtwork items={[]} categoryId="shops" />,
    );
    expect(container.innerHTML).toBe('');
  });
  it('renders matching cover/logo/badge only, without inventing operational vendor text', () => {
    const items = parse([
      {
        id: 'vendor',
        type: 'vendor_presentation',
        placement: 'vendor.presentation',
        vendorId: 'a',
        title: 'Must never replace vendor name',
        label: 'DASH pick',
        image,
        logo: { ...image, alt: 'Curated logo' },
      },
    ]);
    render(<StudioVendorArtwork items={items} vendorId="a" storefront />);
    expect(screen.getByAltText('DASH artwork')).toBeTruthy();
    expect(screen.getByAltText('Curated logo')).toBeTruthy();
    expect(screen.getByText('DASH pick')).toBeTruthy();
    expect(screen.queryByText('Must never replace vendor name')).toBeNull();
  });
  it('does not display another vendor override', () => {
    const { container } = render(
      <StudioVendorArtwork
        items={parse([
          {
            id: 'vendor',
            type: 'vendor_presentation',
            placement: 'vendor.presentation',
            vendorId: 'a',
            title: 'Other vendor',
            image,
          },
        ])}
        vendorId="b"
      />,
    );
    expect(container.innerHTML).toBe('');
  });
  it('shows promotions, collections and announcements but not unchecked featured vendor cards', () => {
    render(
      <StudioDiscovery
        items={parse([
          {
            id: 'news',
            type: 'announcement',
            placement: 'home.announcements',
            title: 'News',
          },
          {
            id: 'promo',
            type: 'promotion',
            placement: 'home.promotions',
            title: 'Promotion',
            image,
            href: '/shops',
          },
          {
            id: 'collection',
            type: 'collection',
            placement: 'home.featured',
            title: 'Collection',
            image,
          },
          {
            id: 'unsafe-vendor',
            type: 'featured_vendor',
            placement: 'home.featured',
            title: 'Ineligible vendor',
            vendorId: 'missing',
            image,
          },
        ])}
      />,
    );
    expect(screen.getByText('News')).toBeTruthy();
    expect(screen.getByText('Promotion')).toBeTruthy();
    expect(screen.getByText('Collection')).toBeTruthy();
    expect(screen.queryByText('Ineligible vendor')).toBeNull();
  });
});
