/** @vitest-environment jsdom */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/dom';
import { parseStudioFeed } from '@dash/domain/content/presentation';
vi.mock('../api', () => ({ apiBaseUrl: 'https://api.dash.test' }));
vi.mock('../theme/ThemeProvider', () => ({
  useTheme: () => ({
    palette: { surface: 'white', line: 'gray', accent: 'gold' },
  }),
}));
vi.mock('../ui/Text', () => ({
  Text: ({ children }: { children: ReactNode }) =>
    createElement('span', null, children),
}));
vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) =>
    createElement('div', null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    disabled,
  }: {
    children: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    disabled?: boolean;
  }) =>
    createElement(
      'button',
      { onClick: onPress, 'aria-label': accessibilityLabel, disabled },
      children,
    ),
}));
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
import {
  StudioHero,
  StudioImage,
  StudioDiscovery,
  studioRoute,
} from './StudioPresentation';
import { useStudioContent } from './useStudioContent';
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement;
const hero = {
  id: 'hero',
  type: 'banner',
  placement: 'home.hero',
  title: 'Published native hero',
  body: 'DASH selected',
  href: '/shops',
  image: {
    url: 'https://assets.dash.test/hero.webp',
    alt: 'Published artwork',
  },
};
const response = (items: unknown[], version = 1) => ({
  ok: true,
  json: async () => ({ schemaVersion: version, items }),
});
const navigate = vi.fn();
function Home() {
  const items = useStudioContent();
  return (
    <>
      <button>Normal browsing</button>
      <StudioHero
        items={items}
        onPush={navigate}
        fallback={<span>Existing home campaign</span>}
      />
    </>
  );
}
async function mount(element: ReactNode) {
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root!.render(element);
  });
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  navigate.mockClear();
});
describe('optional native hero on Android and iOS shared client', () => {
  it.each([
    ['empty', response([])],
    [
      'malformed',
      {
        ok: true,
        json: async () => ({
          schemaVersion: 1,
          items: [null, { title: 'bad' }],
        }),
      },
    ],
    ['future type', response([{ ...hero, type: 'future' }])],
    ['future schema', response([hero], 2)],
  ])('retains existing native UI for %s feeds', async (_label, result) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(result));
    await mount(<Home />);
    expect(container.textContent).toContain('Existing home campaign');
    expect(container.textContent).toContain('Normal browsing');
  });
  it('retains fallback on failed requests', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await mount(<Home />);
    expect(container.textContent).toContain('Existing home campaign');
  });
  it('renders a valid published hero and uses existing customer navigation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([hero])));
    await mount(<Home />);
    expect(container.textContent).toContain(hero.title);
    expect(container.textContent).not.toContain('Existing home campaign');
    await act(async () =>
      fireEvent.click(container.querySelector(`[aria-label="${hero.title}"]`)!),
    );
    expect(navigate).toHaveBeenCalledWith({
      name: 'customer.category',
      params: { id: 'shops' },
    });
  });
  it('restores the complete native campaign after image failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([hero])));
    await mount(<Home />);
    await act(async () => fireEvent.error(container.querySelector('img')!));
    expect(container.textContent).toContain('Existing home campaign');
    expect(container.textContent).toContain('Normal browsing');
    expect(container.textContent).not.toContain(hero.title);
  });
  it('does not wait past 2.5 seconds for a hung content request', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => new Promise(() => undefined)),
    );
    await mount(<Home />);
    expect(container.textContent).toContain('Normal browsing');
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(container.textContent).toContain('Existing home campaign');
  });
  it('retains category/vendor fallback when artwork fails and resets for a replacement URL', async () => {
    const image = parseStudioFeed(
      { schemaVersion: 1, items: [hero] },
      'https://api.dash.test',
    )[0]!.image;
    await mount(
      <StudioImage
        image={image}
        style={{ width: 74, height: 74 }}
        fallback={<span>Original category</span>}
      />,
    );
    await act(async () => fireEvent.error(container.querySelector('img')!));
    expect(container.textContent).toBe('Original category');
    await act(async () =>
      root!.render(
        <StudioImage
          image={{
            ...image!,
            url: 'https://assets.dash.test/replacement.webp',
          }}
          style={{}}
          fallback={null}
        />,
      ),
    );
    expect(container.querySelector('img')?.getAttribute('src')).toContain(
      'replacement.webp',
    );
  });
  it('renders controlled promotions and announcements but never creates a vendor from home.featured', async () => {
    const items = parseStudioFeed(
      {
        schemaVersion: 1,
        items: [
          {
            ...hero,
            id: 'promo',
            type: 'promotion',
            placement: 'home.promotions',
          },
          {
            id: 'news',
            type: 'announcement',
            placement: 'home.announcements',
            title: 'DASH news',
          },
          {
            ...hero,
            id: 'ineligible',
            type: 'featured_vendor',
            placement: 'home.featured',
            title: 'Ineligible vendor',
            vendorId: 'not-in-catalogue',
          },
        ],
      },
      'https://api.dash.test',
    );
    await mount(<StudioDiscovery items={items} onPush={navigate} />);
    expect(container.textContent).toContain('DASH news');
    expect(container.textContent).toContain(hero.title);
    expect(container.textContent).not.toContain('Ineligible vendor');
  });
  it('ignores destinations outside the existing customer surface routes', () => {
    expect(studioRoute('javascript:evil()')).toBeNull();
    expect(studioRoute('/rider')).toBeNull();
    expect(studioRoute('/market')).toEqual({
      name: 'customer.category',
      params: { id: 'local-market' },
    });
  });
});
