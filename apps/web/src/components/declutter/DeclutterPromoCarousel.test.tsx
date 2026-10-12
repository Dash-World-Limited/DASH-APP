// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import campaigns from '../../../public/declutter/promos/campaigns.json';
import {
  CAMPAIGN_MANIFEST,
  DeclutterPromoCarousel,
  parseCampaigns,
} from './DeclutterPromoCarousel';
import { DeclutterHero } from './DeclutterHero';

let desktop = true;
let reduced = false;
const fetchCampaigns = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  desktop = true;
  reduced = false;
  fetchCampaigns.mockReset();
  fetchCampaigns.mockResolvedValue({ ok: true, json: async () => campaigns });
  vi.stubGlobal('fetch', fetchCampaigns);
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      get matches() {
        return query.includes('min-width') ? desktop : reduced;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function carousel() {
  await act(async () => {
    render(<DeclutterPromoCarousel />);
  });
}
function advance() {
  act(() => vi.advanceTimersByTime(6500));
}

it('uses the six supplied campaigns in order, approved dates and no invented links', async () => {
  expect(parseCampaigns(campaigns).map((s) => s.title)).toEqual([
    'DASH App',
    'DASH AI',
    'DASH Rider / Dasher',
    'DASH Declutters',
    'DASH Club',
    'DASH AI Studio',
  ]);
  expect(
    campaigns.filter((s) => s.status?.includes('December')).map((s) => s.title),
  ).toEqual(['DASH App', 'DASH AI']);
  expect(campaigns[3]?.status).toBe('Launching November 1');
  expect(campaigns.slice(4).map((s) => s.status)).toEqual([
    'Coming Soon',
    'Coming Soon',
  ]);
  await carousel();
  expect(fetchCampaigns).toHaveBeenCalledWith(
    CAMPAIGN_MANIFEST,
    expect.objectContaining({ cache: 'no-store' }),
  );
  expect(screen.getAllByRole('img')).toHaveLength(1);
  expect(screen.getByRole('img').getAttribute('src')).toBe(
    '/declutter/promos/dash-app.png',
  );
  expect(screen.getByRole('img').className).toContain('object-contain');
  expect(screen.queryAllByRole('link')).toHaveLength(0);
});

it('rotates one artwork at a time and wraps after the sixth slide', async () => {
  await carousel();
  advance();
  expect(screen.getByRole('heading', { name: 'DASH AI' })).toBeTruthy();
  for (let i = 0; i < 5; i++) advance();
  expect(screen.getByRole('heading', { name: 'DASH App' })).toBeTruthy();
  expect(screen.getAllByRole('img')).toHaveLength(1);
});

it('pauses on hover, resumes on leave and supports persistent pause/play', async () => {
  await carousel();
  const region = screen.getByRole('region');
  fireEvent.mouseEnter(region);
  advance();
  expect(screen.getByRole('heading', { name: 'DASH App' })).toBeTruthy();
  fireEvent.mouseLeave(region);
  advance();
  expect(screen.getByRole('heading', { name: 'DASH AI' })).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 'Pause campaign rotation' }),
  );
  advance();
  expect(screen.getByRole('heading', { name: 'DASH AI' })).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 'Play campaign rotation' }),
  );
  advance();
  expect(
    screen.getByRole('heading', { name: 'DASH Rider / Dasher' }),
  ).toBeTruthy();
});

it('supports arrows, dots and keyboard navigation with current-slide semantics', async () => {
  await carousel();
  fireEvent.click(screen.getByRole('button', { name: 'Previous campaign' }));
  expect(screen.getByRole('heading', { name: 'DASH AI Studio' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Next campaign' }));
  fireEvent.click(screen.getByRole('button', { name: 'Show DASH Club' }));
  expect(
    screen
      .getByRole('button', { name: 'Show DASH Club' })
      .getAttribute('aria-current'),
  ).toBe('true');
  fireEvent.keyDown(screen.getByRole('region'), { key: 'Home' });
  expect(screen.getByRole('heading', { name: 'DASH App' })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('region'), { key: 'ArrowRight' });
  expect(screen.getByRole('heading', { name: 'DASH AI' })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('region'), { key: 'End' });
  expect(screen.getByRole('heading', { name: 'DASH AI Studio' })).toBeTruthy();
  advance();
  expect(screen.getByRole('heading', { name: 'DASH AI Studio' })).toBeTruthy();
});

it('stops rotation during keyboard focus and honours reduced-motion preference', async () => {
  reduced = true;
  await carousel();
  advance();
  expect(screen.getByRole('heading', { name: 'DASH App' })).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 'Play campaign rotation' }),
  );
  fireEvent.focus(screen.getByRole('button', { name: 'Next campaign' }));
  advance();
  expect(screen.getByRole('heading', { name: 'DASH App' })).toBeTruthy();
  fireEvent.blur(screen.getByRole('button', { name: 'Next campaign' }), {
    relatedTarget: document.body,
  });
  advance();
  expect(screen.getByRole('heading', { name: 'DASH AI' })).toBeTruthy();
});

it('keeps the mobile hero clean and does not fetch campaign assets on mobile', async () => {
  desktop = false;
  await act(async () => {
    render(<DeclutterHero />);
  });
  expect(fetchCampaigns).not.toHaveBeenCalled();
  expect(screen.queryAllByRole('img')).toHaveLength(0);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(
    'Second-hand,without the guesswork.',
  );
  expect(screen.getByRole('region').parentElement?.className).toContain(
    'hidden lg:block',
  );
  expect(
    screen
      .getByRole('link', { name: 'Browse the marketplace' })
      .getAttribute('href'),
  ).toBe('#browse');
  expect(
    screen.getByRole('link', { name: 'Sell an item' }).getAttribute('href'),
  ).toBe('/declutter/sell');
});

it('shows only explicitly configured destinations', async () => {
  fetchCampaigns.mockResolvedValue({
    ok: true,
    json: async () => [{ ...campaigns[0], href: '/declutter#browse' }],
  });
  await carousel();
  expect(
    screen.getByRole('link', { name: 'Explore DASH App' }).getAttribute('href'),
  ).toBe('/declutter#browse');
});

it('recovers from unavailable metadata and handles failed artwork honestly', async () => {
  fetchCampaigns.mockResolvedValueOnce({ ok: false });
  await carousel();
  expect(
    screen.getByText('Campaign graphics are temporarily unavailable.'),
  ).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  });
  fireEvent.error(screen.getByRole('img'));
  expect(screen.getByRole('alert').textContent).toContain('could not load');
  fireEvent.click(screen.getByRole('button', { name: 'Next campaign' }));
  expect(screen.getByRole('img').getAttribute('src')).toBe(
    '/declutter/promos/dash-ai.jpg',
  );
});

it('rejects unsafe destinations, invalid images and duplicate campaign identifiers', () => {
  expect(() =>
    parseCampaigns([{ ...campaigns[0], href: 'javascript:alert(1)' }]),
  ).toThrow();
  expect(() =>
    parseCampaigns([
      { ...campaigns[0], image: '/declutter/promos/../private.png' },
    ]),
  ).toThrow();
  expect(() => parseCampaigns([campaigns[0], campaigns[0]])).toThrow();
});
