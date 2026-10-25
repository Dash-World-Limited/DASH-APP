/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
const { catalogue } = vi.hoisted(() => ({ catalogue: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  apiFetch: catalogue,
}));
import type * as ApiModule from '@/lib/api';
import { SectionPage } from '../SectionPage';
const section = {
  slug: 'shops',
  label: 'Shops',
  blurb: 'Existing service copy',
  categories: ['retail'],
};
const vendors = [
  {
    id: 'a',
    slug: 'a',
    name: 'Original A',
    description: 'Original description',
    category: 'retail',
    distanceMetres: 10,
    rating: null,
    branch: { state: 'open', minimumOrder: 500, estimatedMinutes: 10 },
  },
  {
    id: 'b',
    slug: 'b',
    name: 'Original B',
    description: 'Another original',
    category: 'retail',
    distanceMetres: 20,
    rating: null,
    branch: { state: 'closed', minimumOrder: 900, estimatedMinutes: 20 },
  },
];
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  catalogue.mockReset();
});
describe('normal catalogue plus optional Studio content', () => {
  it('promotes only returned vendors while retaining closed status, original names and minimums', async () => {
    catalogue.mockResolvedValue({ vendors });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          schemaVersion: 1,
          items: [
            {
              id: 'excluded',
              type: 'featured_vendor',
              placement: 'home.featured',
              title: 'Unapproved phantom',
              vendorId: 'not-in-catalogue',
              position: 0,
            },
            {
              id: 'featured',
              type: 'featured_vendor',
              placement: 'home.featured',
              title: 'Do not rename B',
              vendorId: 'b',
              position: 1,
            },
            {
              id: 'override',
              type: 'vendor_presentation',
              placement: 'vendor.presentation',
              title: 'Do not rename A',
              vendorId: 'a',
              state: 'open',
              label: 'Editorial pick',
            },
          ],
        }),
      }),
    );
    render(<SectionPage section={section} />);
    await waitFor(() =>
      expect(
        screen.getAllByRole('link').map((link) => link.getAttribute('href')),
      ).toEqual(['/browse/b', '/browse/a']),
    );
    expect(screen.getByText('Original A')).toBeTruthy();
    expect(screen.getByText('Original B')).toBeTruthy();
    expect(screen.getByText('Closed')).toBeTruthy();
    expect(screen.queryByText('Unapproved phantom')).toBeNull();
    expect(screen.queryByText('Do not rename A')).toBeNull();
    expect(vendors[1]?.branch.state).toBe('closed');
    expect(catalogue).toHaveBeenCalledWith(
      expect.stringContaining('/v1/vendors?'),
    );
  });
  it('retains original catalogue order, labels and rendering through a Studio outage', async () => {
    catalogue.mockResolvedValue({ vendors });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Studio offline')),
    );
    render(<SectionPage section={section} />);
    await screen.findByText('Original B');
    expect(
      screen.getAllByRole('link').map((link) => link.getAttribute('href')),
    ).toEqual(['/browse/a', '/browse/b']);
    expect(screen.getByText('Existing service copy')).toBeTruthy();
    expect(screen.getByText('Closed')).toBeTruthy();
  });
});
