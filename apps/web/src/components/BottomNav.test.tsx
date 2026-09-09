// @vitest-environment jsdom

/**
 * The navigation is the one component every customer screen shares.
 *
 * Which makes it the one component where a well-meaning change does the most
 * damage: adding a sixth destination, reordering the five, or letting a detail
 * page darken every tab is not a visual regression on one screen — it is a
 * regression on all of them at once, and it is the kind of thing that looks
 * fine in a screenshot of whatever page the author happened to be on.
 *
 * So these assert the structure rather than the styling. The order is a product
 * decision, "you are here" is a claim that has to survive detail routes, and
 * the indicator's position is the only part of the motion that is worth testing
 * — whether it slides is a matter for the device, but *where it slides to* is
 * arithmetic and can be wrong.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let pathname = '/home';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

import { BottomNav, DESTINATIONS } from './BottomNav';

const at = (path: string) => {
  pathname = path;
  return render(<BottomNav />);
};

afterEach(cleanup);

describe('the locked five', () => {
  it('offers exactly the approved destinations, in order', () => {
    // Home, Search, Orders, Wallet, Account. Not four, not six, and not
    // reordered — a returning customer knows where Orders is by position.
    expect(DESTINATIONS.map((d) => d.label)).toEqual([
      'Home',
      'Search',
      'Orders',
      'Wallet',
      'Account',
    ]);
    expect(DESTINATIONS.map((d) => d.href)).toEqual([
      '/home',
      '/search',
      '/orders',
      '/wallet',
      '/account',
    ]);
  });

  it('renders every destination as a link, and nothing else', () => {
    at('/home');
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(DESTINATIONS.length);
  });

  it('does not carry the mode switch', () => {
    // Customer to Rider is a property of the account and lives in the drawer.
    // A sixth tab is the obvious place to put it and the wrong one.
    at('/home');
    expect(screen.queryByText(/rider/i)).toBeNull();
  });
});

describe('you are here', () => {
  it('marks the current destination for assistive technology', () => {
    at('/wallet');
    expect(screen.getByRole('link', { name: /wallet/i }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('keeps Home lit on the screens Home owns', () => {
    // A seller page and a section page are reached from Home and belong to it.
    // Without this the whole bar goes dark the moment a customer taps a shop,
    // which reads as "you have left the app".
    for (const path of ['/browse/iya-kemi', '/shops', '/restaurants', '/pharmacy', '/declutter']) {
      cleanup();
      at(path);
      expect(
        screen.getByRole('link', { name: /home/i }).getAttribute('aria-current'),
        path,
      ).toBe('page');
    }
  });

  it('marks exactly one destination at a time', () => {
    for (const path of ['/home', '/search', '/orders', '/wallet', '/account', '/browse/x']) {
      cleanup();
      at(path);
      const current = screen
        .getAllByRole('link')
        .filter((link) => link.getAttribute('aria-current') === 'page');
      expect(current, path).toHaveLength(1);
    }
  });

  it('marks nothing on a screen the bar does not own', () => {
    // `/basket` is reached from the header. Highlighting a tab the customer is
    // not on would be a lie about where they are.
    at('/basket');
    expect(
      screen.getAllByRole('link').filter((l) => l.getAttribute('aria-current') === 'page'),
    ).toHaveLength(0);
  });
});

describe('the indicator', () => {
  const indicatorIn = (container: HTMLElement): HTMLElement | null =>
    container.querySelector('li[aria-hidden="true"]');

  it('travels to the active destination', () => {
    // A percentage of its own width per step, so the arithmetic is the index
    // and nothing has to be measured.
    for (const [index, destination] of DESTINATIONS.entries()) {
      cleanup();
      const { container } = at(destination.href);
      expect(indicatorIn(container)?.style.transform, destination.href).toBe(
        `translateX(${index * 100}%)`,
      );
    }
  });

  it('is one fifth of the row, so it lands on a tab rather than between two', () => {
    // jsdom rewrites `calc((100% - 0.75rem) / 5)` into `calc(0.2 * (100% -
    // 0.75rem))`, so the assertion is on the fraction rather than on the text.
    // The property that matters is that one step of the transform is exactly
    // one tab wide — anything else and the indicator drifts further from the
    // active tab with every step along the row.
    const { container } = at('/home');
    const width = indicatorIn(container)?.style.width ?? '';
    const fraction = width.includes(`/ ${DESTINATIONS.length}`)
      ? 1 / DESTINATIONS.length
      : Number(/calc\(\s*([0-9.]+)\s*\*/.exec(width)?.[1]);
    expect(fraction, width).toBeCloseTo(1 / DESTINATIONS.length, 6);
  });

  it('is not rendered at all when nothing is active', () => {
    const { container } = at('/basket');
    expect(indicatorIn(container)).toBeNull();
  });

  it('is hidden from assistive technology and from taps', () => {
    // It is decoration that happens to be positioned over a control.
    const { container } = at('/orders');
    const indicator = indicatorIn(container);
    expect(indicator).not.toBeNull();
    expect(indicator?.className).toContain('pointer-events-none');
  });
});

describe('what it no longer claims', () => {
  it('puts no basket count on the Orders tab', () => {
    // It used to render the number of items in the basket as a badge on
    // Orders. Those are different things: a basket is not an order, and a
    // customer with three items in a basket has no orders at all.
    at('/home');
    const orders = screen.getByRole('link', { name: /orders/i });
    expect(orders.textContent).toBe('Orders');
  });
});
