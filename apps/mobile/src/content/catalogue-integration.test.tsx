/** @vitest-environment jsdom */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/dom';
import { parseStudioFeed } from '@dash/domain/content/presentation';
import type { PublicContentItem } from '@dash/domain/content';
const state = vi.hoisted(() => ({
  request: vi.fn(),
  items: [] as PublicContentItem[],
}));
vi.mock('../api', () => ({
  api: { configured: true, request: state.request },
  ApiError: class extends Error {},
}));
vi.mock('./useStudioContent', () => ({ useStudioContent: () => state.items }));
vi.mock('../features/CartProvider', () => ({
  useCart: () => {
    throw new Error('Presentation must not access cart');
  },
}));
vi.mock('../v2/declutter/DeclutterScreens', () => ({
  DeclutterFeedScreen: () => null,
}));
vi.mock('../v2/artwork/CategoryPhoto', () => ({
  CategoryPhoto: ({ accessibilityLabel }: { accessibilityLabel: string }) =>
    createElement('span', null, accessibilityLabel),
}));
vi.mock('../theme/ThemeProvider', () => ({
  useTheme: () => ({
    palette: { surface: 'white', line: 'gray', accent: 'gold' },
  }),
}));
vi.mock('../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../ui/Text', () => ({
  Text: ({ children }: { children: ReactNode }) =>
    createElement('span', null, children),
}));
vi.mock('react-native', () => {
  const Box = ({ children }: { children: ReactNode }) =>
    createElement('div', null, children);
  return {
    View: Box,
    ScrollView: Box,
    ActivityIndicator: () => null,
    Alert: {},
    TextInput: () => null,
    Pressable: ({
      children,
      onPress,
      accessibilityLabel,
    }: {
      children: ReactNode;
      onPress?: () => void;
      accessibilityLabel?: string;
    }) =>
      createElement(
        'button',
        { onClick: onPress, 'aria-label': accessibilityLabel },
        children,
      ),
  };
});
vi.mock('expo-image', () => ({
  Image: ({
    source,
    accessibilityLabel,
    onError,
  }: {
    source: { uri: string };
    accessibilityLabel: string;
    onError: () => void;
  }) =>
    createElement('img', { src: source.uri, alt: accessibilityLabel, onError }),
}));
import { CategoryDashboard, Storefront } from '../v2/catalog/CatalogScreens';
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement;
async function mount(node: ReactNode) {
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root!.render(node));
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  state.request.mockReset();
  state.items = [];
});
const parse = (items: unknown[]) =>
  parseStudioFeed({ schemaVersion: 1, items }, 'https://api.dash.test');
describe('native catalogue binding', () => {
  it('matches Studio by API vendor ID, orders only catalogue results, and keeps slug navigation', async () => {
    state.request.mockResolvedValue({
      vendors: [
        {
          id: 'a-api',
          slug: 'a-route',
          name: 'Original A',
          description: 'A',
          rating: { average: 0, count: 0 },
          branch: null,
        },
        {
          id: 'b-api',
          slug: 'b-route',
          name: 'Original B',
          description: 'B',
          rating: { average: 0, count: 0 },
          branch: null,
        },
      ],
    });
    state.items = parse([
      {
        id: 'missing',
        type: 'featured_vendor',
        placement: 'home.featured',
        title: 'Missing vendor',
        vendorId: 'not-returned',
        position: 0,
      },
      {
        id: 'b',
        type: 'featured_vendor',
        placement: 'home.featured',
        title: 'Not the vendor name',
        vendorId: 'b-api',
        position: 1,
      },
    ]);
    const push = vi.fn();
    await mount(<CategoryDashboard id="food" onBack={vi.fn()} onPush={push} />);
    const buttons = [...container.querySelectorAll('button')].filter((b) =>
      b.getAttribute('aria-label')?.startsWith('Open Original'),
    );
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Open Original B',
      'Open Original A',
    ]);
    expect(container.textContent).not.toContain('Missing vendor');
    expect(container.textContent).not.toContain('Not the vendor name');
    await act(async () => fireEvent.click(buttons[0]!));
    expect(push).toHaveBeenCalledWith({
      name: 'customer.store',
      params: { category: 'food', id: 'b-route' },
    });
    expect(state.request).toHaveBeenCalledWith(
      '/v1/vendors?service=food&limit=20',
      expect.objectContaining({ auth: false }),
    );
  });
  it('binds cover, logo and label to the returned storefront without replacing operational identity', async () => {
    state.request.mockResolvedValue({
      vendor: {
        id: 'api-id',
        slug: 'route-slug',
        name: 'Original store',
        description: 'Operational description',
        ratingAverage: 4,
        categories: [],
      },
    });
    const image = { url: 'https://assets.test/cover.webp', alt: 'DASH cover' };
    state.items = parse([
      {
        id: 'presentation',
        type: 'vendor_presentation',
        placement: 'vendor.presentation',
        title: 'Do not rename this vendor',
        vendorId: 'api-id',
        image,
        logo: { ...image, alt: 'DASH logo' },
        label: 'DASH selected',
      },
    ]);
    await mount(
      <Storefront
        category="shops"
        merchantId="route-slug"
        onBack={vi.fn()}
        onPush={vi.fn()}
      />,
    );
    expect(container.querySelector('img[alt="DASH cover"]')).toBeTruthy();
    expect(container.querySelector('img[alt="DASH logo"]')).toBeTruthy();
    expect(container.textContent).toContain('Original store');
    expect(container.textContent).toContain('Operational description');
    expect(container.textContent).toContain('DASH selected');
    expect(container.textContent).not.toContain('Do not rename this vendor');
    await act(async () =>
      fireEvent.error(container.querySelector('img[alt="DASH cover"]')!),
    );
    expect(container.textContent).toContain('Original store');
  });
});
