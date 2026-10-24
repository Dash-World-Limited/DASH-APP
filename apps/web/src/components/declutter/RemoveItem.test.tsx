// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { RemoveItem } from './RemoveItem';
import { hubFixture } from './hub-fixture';
const fetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/session', () => ({ authedFetch: fetch }));
beforeEach(() => {
  fetch.mockReset().mockResolvedValue({ ok: true });
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);
it.each([false, true])(
  'requires confirmation before removing an item (live: %s)',
  async (live) => {
    const changed = vi.fn().mockResolvedValue(undefined);
    const item = hubFixture(
      live
        ? {
            status: 'Live',
            listing: {
              slug: 'chair',
              priceKobo: 1_000_000,
              publishedAt: '2026-10-11',
              availability: 'available',
            },
          }
        : {},
    );
    render(<RemoveItem item={item} onChanged={changed} />);
    const label = live ? 'Remove listing' : 'Delete submission';
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(screen.getByRole('dialog', { name: `${label}?` })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep item' }));
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: label }));
    fireEvent.click(screen.getAllByRole('button', { name: label })[1]!);
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith(
      '/v1/declutter/account/items/item-1/remove',
      { method: 'POST', body: { confirmed: true } },
    );
  },
);
it.each(['Sold', 'Removed'])(
  'does not offer removal for %s items',
  (status) => {
    render(<RemoveItem item={hubFixture({ status })} onChanged={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
  },
);
it('keeps the confirmation open with a retryable error if removal fails', async () => {
  fetch.mockRejectedValue(new Error('Connection interrupted'));
  render(<RemoveItem item={hubFixture()} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Delete submission' }));
  fireEvent.click(
    screen.getAllByRole('button', { name: 'Delete submission' })[1]!,
  );
  await screen.findByRole('alert');
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getByText('Connection interrupted')).toBeTruthy();
});
