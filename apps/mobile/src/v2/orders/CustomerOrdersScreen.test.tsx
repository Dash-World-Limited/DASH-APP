// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  os: 'ios', state: 'active', session: 'authenticated', request: vi.fn(),
  listeners: new Set<(state: string) => void>(),
}));
vi.mock('react-native', () => ({
  Platform: { get OS() { return h.os; } },
  AppState: {
    get currentState() { return h.state; },
    addEventListener: (_type: string, listener: (state: string) => void) => {
      h.listeners.add(listener);
      return { remove: () => h.listeners.delete(listener) };
    },
  },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress }: { children: ReactNode; onPress: () => void }) => <button onClick={onPress}>{children}</button>,
  ActivityIndicator: () => <span>Loading</span>,
  Alert: {}, Linking: {},
}));
vi.mock('../../api', () => ({ api: { configured: true, request: h.request }, ApiError: class extends Error {} }));
vi.mock('../auth/AppSessionProvider', () => ({ useAppSession: () => ({ state: h.session }) }));
vi.mock('../../features/orderMemory', () => ({ recallOrder: vi.fn(), rememberOrder: vi.fn() }));
vi.mock('../../rider/MapShell', () => ({ MapShell: () => null }));
vi.mock('./RateRiderCard', () => ({ RateRiderCard: () => null }));
vi.mock('../../theme/ThemeProvider', () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock('../../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../../ui/Text', () => ({ Text: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock('./parts', () => {
  const Box = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    OrderPage: Box, Card: Box, BackHeader: () => null,
    Empty: ({ title }: { title: string }) => <p>{title}</p>,
    Notice: ({ text }: { text: string }) => <p>{text}</p>,
    PrimaryCheckoutButton: () => null, SecondaryButton: () => null,
  };
});

import { CustomerOrdersScreen } from './CustomerOrderScreens';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null;
let container: HTMLDivElement;
const order = (code: string) => ({
  id: code, code, status: 'preparing', statusLabel: 'Preparing', phase: 'preparing',
  total: 10000, createdAt: '2026-10-19T10:00:00Z',
  vendor: { name: 'Test shop', slug: 'test', category: 'food' }, items: [],
});
const settle = () => act(async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); });
async function render() {
  await act(async () => root!.render(<CustomerOrdersScreen onTrack={() => undefined} onAccount={() => undefined} />));
  await settle();
}
async function mount() {
  container = document.createElement('div'); root = createRoot(container); await render();
}
async function appState(next: string) {
  await act(async () => { h.state = next; for (const listener of h.listeners) listener(next); });
  await settle();
}
async function segment(label: string) {
  const button = [...container.querySelectorAll('button')].find(node => node.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click()); await settle();
}
beforeEach(() => {
  h.os = 'ios'; h.state = 'active'; h.session = 'authenticated'; h.listeners.clear();
  h.request.mockReset().mockResolvedValue({ orders: [order('OLD')] });
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; });

describe('Customer Orders recovery after iOS suspension', () => {
  it('reloads the mounted list from the server after a full resume', async () => {
    await mount(); expect(container.textContent).toContain('OLD');
    await appState('background');
    h.request.mockResolvedValue({ orders: [order('NEW')] });
    await appState('active');
    expect(container.textContent).toContain('NEW');
    expect(container.textContent).not.toContain('OLD');
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.request).toHaveBeenLastCalledWith('/v1/orders?status=active&limit=20');
  });

  it('recovers a failed initial load when connectivity returns during suspension', async () => {
    h.request.mockRejectedValueOnce(new Error('Offline'));
    await mount(); expect(container.textContent).toContain('Could not load your orders.');
    await appState('background'); await appState('active');
    expect(container.textContent).toContain('OLD');
    expect(container.textContent).not.toContain('Could not load your orders.');
  });

  it('reloads the selected History segment rather than resetting it', async () => {
    await mount(); await segment('History');
    h.request.mockResolvedValue({ orders: [order('COMPLETED')] });
    await appState('background'); await appState('active');
    expect(h.request).toHaveBeenLastCalledWith('/v1/orders?status=past&limit=20');
    expect(container.textContent).toContain('COMPLETED');
  });

  it('ignores permission-dialog transitions and duplicate active events', async () => {
    await mount(); await appState('inactive'); await appState('active'); await appState('active');
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'failure'])('ignores an older pending %s after newer resume data', async (result) => {
    let finish!: (value: unknown) => void;
    let fail!: (error: Error) => void;
    h.request.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    await mount();
    h.request.mockResolvedValue({ orders: [order('NEW')] });
    await appState('background'); await appState('active');
    await act(async () => { if (result === 'success') finish({ orders: [order('STALE')] }); else fail(new Error('Offline')); });
    await settle();
    expect(container.textContent).toContain('NEW');
    expect(container.textContent).not.toContain('STALE');
    expect(container.textContent).not.toContain('Could not load your orders.');
  });

  it('does not let a delayed Active response replace the selected History list', async () => {
    let finish!: (value: unknown) => void;
    h.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await mount(); h.request.mockResolvedValue({ orders: [order('HISTORY')] });
    await segment('History');
    await act(async () => finish({ orders: [order('STALE-ACTIVE')] })); await settle();
    expect(container.textContent).toContain('HISTORY');
    expect(container.textContent).not.toContain('STALE-ACTIVE');
  });

  it('keeps the current loading state when an obsolete request finishes first', async () => {
    let oldFinish!: (value: unknown) => void;
    let currentFinish!: (value: unknown) => void;
    h.request.mockImplementationOnce(() => new Promise(resolve => { oldFinish = resolve; }));
    await mount();
    h.request.mockImplementationOnce(() => new Promise(resolve => { currentFinish = resolve; }));
    await appState('background'); await appState('active');
    await act(async () => oldFinish({ orders: [order('STALE')] })); await settle();
    expect(container.textContent).toContain('Loading');
    expect(container.textContent).not.toContain('STALE');
    await act(async () => currentFinish({ orders: [order('NEW')] })); await settle();
    expect(container.textContent).not.toContain('Loading');
    expect(container.textContent).toContain('NEW');
  });

  it('shows a resume failure without discarding known orders and retries on the next resume', async () => {
    await mount();
    h.request.mockRejectedValueOnce(new Error('Offline'));
    await appState('background'); await appState('active');
    expect(container.textContent).toContain('OLD');
    expect(container.textContent).toContain('Could not load your orders.');
    h.request.mockResolvedValue({ orders: [] });
    await appState('background'); await appState('active');
    expect(container.textContent).toContain('No active delivery');
    expect(container.textContent).not.toContain('Could not load your orders.');
    expect(h.request).toHaveBeenCalledTimes(3);
  });

  it('drops pending results and removes the resume listener at sign-out', async () => {
    let finish!: (value: unknown) => void;
    h.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await mount(); h.session = 'unauthenticated'; await render();
    await act(async () => finish({ orders: [order('PRIVATE-OLD')] })); await settle();
    await appState('background'); await appState('active');
    expect(h.listeners.size).toBe(0);
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('PRIVATE-OLD');
  });

  it('does not retain the iOS listener after the screen unmounts', async () => {
    await mount(); await act(async () => root!.unmount()); root = null;
    await appState('background'); await appState('active');
    expect(h.listeners.size).toBe(0); expect(h.request).toHaveBeenCalledTimes(1);
  });

  it('preserves Android loading and tab behavior without adding resume requests', async () => {
    h.os = 'android'; await mount();
    await appState('background'); await appState('active');
    expect(h.listeners.size).toBe(0); expect(h.request).toHaveBeenCalledTimes(1);
    await segment('History');
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.request).toHaveBeenLastCalledWith('/v1/orders?status=past&limit=20');
  });
});
