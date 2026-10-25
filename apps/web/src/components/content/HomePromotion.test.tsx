/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { HomePromotion } from './HomePromotion';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const banner = {
  id: 'hero',
  type: 'banner',
  placement: 'home.hero',
  title: 'The weekend edit',
  body: 'Handpicked by DASH',
  href: '/shops',
  image: { url: 'https://assets.test/image.webp', alt: 'Weekend goods' },
};
function response(data: unknown, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok, json: async () => data }),
  );
}
describe('optional home presentation', () => {
  it('renders a published banner with a working app destination', async () => {
    response({ schemaVersion: 1, items: [banner] });
    render(<HomePromotion />);
    expect(await screen.findByText('The weekend edit')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/shops');
  });
  it('removes a failed image and leaves the existing screen usable', async () => {
    response({ schemaVersion: 1, items: [banner] });
    const { container } = render(<HomePromotion />);
    fireEvent.error(await screen.findByAltText('Weekend goods'));
    expect(container.innerHTML).toBe('');
  });
  it('resolves local signed images against the API origin', async () => {
    response({
      schemaVersion: 1,
      items: [
        {
          ...banner,
          image: {
            ...banner.image,
            url: '/v1/files/content-studio%2Ftest?signature=test',
          },
        },
      ],
    });
    render(<HomePromotion />);
    const image = await screen.findByAltText('Weekend goods');
    expect(image.getAttribute('src')).toContain(
      '/v1/files/content-studio%2Ftest?signature=test',
    );
  });
  it.each([
    { schemaVersion: 1, items: [] },
    { schemaVersion: 2, items: [banner] },
    { schemaVersion: 1, items: [{ ...banner, type: 'new_component' }] },
    { schemaVersion: 1, items: [{ ...banner, href: 'javascript:evil()' }] },
    { schemaVersion: 1, items: [null] },
    {
      schemaVersion: 1,
      items: [{ ...banner, image: { ...banner.image, url: 'https://' } }],
    },
  ])(
    'retains defaults for empty, unknown or invalid content: %j',
    async (data) => {
      response(data);
      const { container } = render(<HomePromotion />);
      await waitFor(() => expect(fetch).toHaveBeenCalled());
      expect(container.innerHTML).toBe('');
    },
  );
  it('silently retains defaults on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const { container } = render(<HomePromotion />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });
});
