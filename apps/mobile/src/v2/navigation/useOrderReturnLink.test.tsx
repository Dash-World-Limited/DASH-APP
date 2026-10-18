// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  os: 'ios', initial: vi.fn(), listeners: new Set<(event: { url: string }) => void>(),
}));
vi.mock('react-native', () => ({
  Platform: { get OS() { return h.os; } },
  Linking: {
    getInitialURL: () => h.initial(),
    addEventListener: (_type: string, listener: (event: { url: string }) => void) => {
      h.listeners.add(listener);
      return { remove: () => h.listeners.delete(listener) };
    },
  },
}));
import { createNavigationState, currentRoute, navigate } from './model';
import { orderReturnNavigation, useOrderReturnLink } from './useOrderReturnLink';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
const opened = vi.fn();
function Probe() { useOrderReturnLink(opened); return null; }
async function mount() {
  root = createRoot(document.createElement('div'));
  await act(async () => root!.render(<Probe />));
}
beforeEach(() => { h.os = 'ios'; h.initial.mockReset().mockResolvedValue(null); h.listeners.clear(); opened.mockClear(); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; });

describe('existing payment return link', () => {
  it.each(['dash://orders', 'dash://orders/', 'dash://orders?status=success&orderId=someone-else', 'dash://orders?status=cancelled', 'dash://orders?status=failed'])(
    'opens only server-backed Customer Orders for %s', (url) => {
      const next = orderReturnNavigation(url, navigate(createNavigationState('customer'), { name: 'customer.checkout' }), false);
      expect(next?.face).toBe('customer');
      expect(next && currentRoute(next)).toEqual({ name: 'customer.orders' });
    },
  );
  it.each(['https://orders', 'dash://orders.evil.test', 'dash://user:pass@orders', 'dash://orders/other', 'dash://rider.delivery', 'not a URL', 'dash://orders#paid'])(
    'ignores unrelated/malformed link %s', (url) => expect(orderReturnNavigation(url, createNavigationState('customer'), false)).toBeNull(),
  );
  it('preserves an active Rider delivery', () => {
    expect(orderReturnNavigation('dash://orders', navigate(createNavigationState('rider'), { name: 'rider.delivery' }), true)).toBeNull();
  });
  it('allows an idle Rider to return to their Customer orders', () => {
    const next = orderReturnNavigation('dash://orders', createNavigationState('rider'), false);
    expect(next?.face).toBe('customer');
    expect(next && currentRoute(next).name).toBe('customer.orders');
  });
  it('receives a cold-start callback when authenticated navigation mounts', async () => {
    h.initial.mockResolvedValue('dash://orders');
    await mount();
    expect(opened).toHaveBeenCalledWith('dash://orders');
  });
  it('receives a callback while the app is open', async () => {
    await mount();
    await act(async () => { for (const listener of h.listeners) listener({ url: 'dash://orders' }); });
    expect(opened).toHaveBeenCalledExactlyOnceWith('dash://orders');
  });
  it('does not let a delayed initial URL override a newer event', async () => {
    let done!: (url: string) => void;
    h.initial.mockImplementation(() => new Promise<string>((resolve) => { done = resolve; }));
    await mount();
    await act(async () => { for (const listener of h.listeners) listener({ url: 'dash://orders' }); done('dash://unrelated'); });
    expect(opened).toHaveBeenCalledExactlyOnceWith('dash://orders');
  });
  it('drops a delayed callback after navigation unmounts at sign-out', async () => {
    let done!: (url: string) => void;
    h.initial.mockImplementation(() => new Promise<string>((resolve) => { done = resolve; }));
    await mount();
    await act(async () => root!.unmount());
    root = null;
    await act(async () => done('dash://orders'));
    expect(h.listeners.size).toBe(0);
    expect(opened).not.toHaveBeenCalled();
  });
  it('leaves the existing Android link behavior untouched', async () => {
    h.os = 'android';
    await mount();
    expect(h.initial).not.toHaveBeenCalled();
    expect(h.listeners.size).toBe(0);
  });
});
