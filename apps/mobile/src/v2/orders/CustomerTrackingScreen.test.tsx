// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  os: 'ios', state: 'active', session: 'authenticated', request: vi.fn(), recall: vi.fn(),
  listeners: new Set<(state: string) => void>(),
}));
vi.mock('react-native', () => ({
  Platform: { get OS() { return h.os; } },
  AppState: {
    get currentState() { return h.state; },
    addEventListener: (_: string, listener: (state: string) => void) => {
      h.listeners.add(listener); return { remove: () => h.listeners.delete(listener) };
    },
  },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress }: { children: ReactNode; onPress: () => void }) => <button onClick={onPress}>{children}</button>,
  ActivityIndicator: () => <span>Loading</span>, Alert: {}, Linking: {},
}));
vi.mock('../../api', () => ({ api: { configured: true, request: h.request }, ApiError: class extends Error {} }));
vi.mock('../auth/AppSessionProvider', () => ({ useAppSession: () => ({ state: h.session }) }));
vi.mock('../../features/orderMemory', () => ({ recallOrder: h.recall, rememberOrder: vi.fn() }));
vi.mock('../../rider/MapShell', () => ({ MapShell: () => null }));
vi.mock('./RateRiderCard', () => ({ RateRiderCard: () => null }));
vi.mock('../../theme/ThemeProvider', () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock('../../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../../ui/Text', () => ({ Text: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock('./parts', () => {
  const Box = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  const Button = ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => <button disabled={disabled} onClick={onPress}>{label}</button>;
  return {
    OrderPage: Box, Card: Box, BackHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
    Empty: ({ title, body }: { title: string; body: string }) => <p>{title} {body}</p>,
    Notice: ({ text }: { text: string }) => <p>{text}</p>,
    PrimaryCheckoutButton: Button, SecondaryButton: Button,
  };
});
import { CustomerTrackingScreen } from './CustomerOrderScreens';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null;
let container: HTMLDivElement;
const detail = (status: string, code = 'ORDER-A') => ({ order: {
  id: code, code, status, statusLabel: `Server: ${status}`, phase: status,
  total: 10000, itemsSubtotal: 10000, discountTotal: 0, deliveryFee: 0, serviceFee: 0,
  smallOrderFee: 0, surgeAmount: 0, tax: 0, tip: 0, createdAt: '2026-10-19T10:00:00Z',
  vendor: { name: 'Test shop', slug: 'test', category: 'food' }, items: [],
  branch: { name: 'Test shop', address: 'Test address', latitude: 0, longitude: 0 },
  address: null, rider: null, statusEvents: [],
}, cancellation: { allowed: status === 'payment_pending', explanation: 'Server cancellation policy' } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => act(async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); });
async function render(id = 'ORDER-A') {
  if (!root) { container = document.createElement('div'); root = createRoot(container); }
  await act(async () => root!.render(<CustomerTrackingScreen orderId={id} onBack={() => undefined} onChat={() => undefined} />));
  await settle();
}
async function appState(next: string) {
  await act(async () => { h.state = next; for (const listener of h.listeners) listener(next); }); await settle();
}
async function unmount() { await act(async () => root!.unmount()); root = null; }
const verifyCalls = () => h.request.mock.calls.filter(([url]) => String(url).includes('/payment/verify'));
beforeEach(() => {
  h.os = 'ios'; h.state = 'active'; h.session = 'authenticated'; h.listeners.clear();
  h.request.mockReset().mockResolvedValue(detail('preparing')); h.recall.mockReset().mockResolvedValue({});
});
afterEach(async () => { if (root) await unmount(); vi.useRealTimers(); });

describe('iOS order detail reads across suspension and navigation', () => {
  it('does not roll back a newer resume result or verify an obsolete pending order', async () => {
    const old = deferred<ReturnType<typeof detail>>();
    h.request.mockImplementationOnce(() => old.promise);
    await render(); await appState('background'); await appState('active');
    expect(container.textContent).toContain('Server: preparing');
    await act(async () => old.resolve(detail('payment_pending'))); await settle();
    expect(container.textContent).toContain('Server: preparing');
    expect(container.textContent).not.toContain('Server: payment_pending');
    expect(verifyCalls()).toHaveLength(0);
    expect(container.textContent).not.toContain('Cancel this order');
  });
  it('keeps a newer resume failure visible when an older read succeeds', async () => {
    await render();
    const old = deferred<ReturnType<typeof detail>>();
    h.request.mockImplementationOnce(() => old.promise).mockRejectedValueOnce(new Error('offline'));
    await appState('background'); await appState('active');
    await appState('background'); await appState('active');
    expect(container.textContent).toContain('Could not refresh this delivery.');
    await act(async () => old.resolve(detail('preparing'))); await settle();
    expect(container.textContent).toContain('Could not refresh this delivery.');
  });
  it('ignores an older request error after a newer resume succeeds', async () => {
    const old = deferred<ReturnType<typeof detail>>();
    h.request.mockImplementationOnce(() => old.promise);
    await render(); await appState('background'); await appState('active');
    await act(async () => old.reject(new Error('suspended request failed'))); await settle();
    expect(container.textContent).toContain('Server: preparing');
    expect(container.textContent).not.toContain('Could not refresh this delivery.');
  });
  it('does not let the previous order response replace a newly opened detail', async () => {
    const old = deferred<ReturnType<typeof detail>>();
    h.request.mockImplementationOnce(() => old.promise).mockResolvedValueOnce(detail('delivered', 'ORDER-B'));
    await render(); await render('ORDER-B');
    expect(container.textContent).toContain('Order ORDER-B');
    await act(async () => old.resolve(detail('preparing'))); await settle();
    expect(container.textContent).toContain('Order ORDER-B');
    expect(container.textContent).not.toContain('Order ORDER-A');
  });
  it('cannot start an old payment verification after navigation unmounts at logout or a payment return', async () => {
    const old = deferred<ReturnType<typeof detail>>();
    h.request.mockImplementationOnce(() => old.promise);
    await render(); await unmount();
    await render('ORDER-B'); // new authenticated navigation lifetime
    await act(async () => old.resolve(detail('payment_pending'))); await settle();
    expect(verifyCalls()).toHaveLength(0);
    expect(h.request).toHaveBeenCalledTimes(2);
  });
  it('does not let a suspended verification overwrite a newer resume verification', async () => {
    const old = deferred<{ payment: { outcome: string } }>();
    h.request.mockResolvedValueOnce(detail('payment_pending'))
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce({ payment: { outcome: 'captured' } })
      .mockResolvedValueOnce(detail('preparing'));
    await render(); await appState('background'); await appState('active');
    expect(container.textContent).toContain('Server: preparing');
    await act(async () => old.resolve({ payment: { outcome: 'failed' } })); await settle();
    expect(container.textContent).not.toContain('Pay again');
    expect(h.request).toHaveBeenCalledTimes(4);
  });
  it('does not let a verification surviving logout start a detail request in a later session', async () => {
    const old = deferred<{ payment: { outcome: string } }>();
    h.request.mockResolvedValueOnce(detail('payment_pending')).mockImplementationOnce(() => old.promise);
    await render(); await unmount(); await render('ORDER-B');
    await act(async () => old.resolve({ payment: { outcome: 'captured' } })); await settle();
    expect(h.request).toHaveBeenCalledTimes(3);
  });
  it('does not replace the new order delivery PIN with a delayed old local read', async () => {
    const old = deferred<{ deliveryPin: string }>();
    h.recall.mockImplementationOnce(() => old.promise).mockResolvedValueOnce({ deliveryPin: '2222' });
    await render(); await render('ORDER-B');
    expect(container.textContent).toContain('2222');
    await act(async () => old.resolve({ deliveryPin: '1111' })); await settle();
    expect(container.textContent).toContain('2222');
    expect(container.textContent).not.toContain('1111');
  });
  it('keeps the initial loader visible while the newer resume read is pending', async () => {
    const old = deferred<ReturnType<typeof detail>>();
    const latest = deferred<ReturnType<typeof detail>>();
    h.request.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => latest.promise);
    await render(); await appState('background'); await appState('active');
    await act(async () => old.resolve(detail('payment_pending'))); await settle();
    expect(container.textContent).toContain('Loading');
    expect(container.textContent).not.toContain('Server: payment_pending');
    expect(verifyCalls()).toHaveLength(0);
    await act(async () => latest.resolve(detail('preparing'))); await settle();
    expect(container.textContent).toContain('Server: preparing');
  });
  it('does not let an older failed verification clear a newer verification loading state', async () => {
    const old = deferred<{ payment: { outcome: string } }>();
    const latest = deferred<{ payment: { outcome: string } }>();
    h.request.mockResolvedValueOnce(detail('payment_pending'))
      .mockImplementationOnce(() => old.promise).mockImplementationOnce(() => latest.promise);
    await render(); await appState('background'); await appState('active');
    await act(async () => old.reject(new Error('old verification failed'))); await settle();
    expect(container.textContent).toContain('Checking…');
    expect(container.textContent).not.toContain('Could not check this payment.');
    await act(async () => latest.resolve({ payment: { outcome: 'captured' } })); await settle();
    expect(container.textContent).toContain('Server: preparing');
    expect(h.request).toHaveBeenCalledTimes(4);
  });
  it('ignores a verification superseded by a newer polled detail result', async () => {
    vi.useFakeTimers();
    const old = deferred<{ payment: { outcome: string } }>();
    h.request.mockResolvedValueOnce(detail('payment_pending')).mockImplementationOnce(() => old.promise);
    await render();
    await act(async () => { vi.advanceTimersByTime(12_000); }); await settle();
    expect(container.textContent).toContain('Server: preparing');
    await act(async () => old.resolve({ payment: { outcome: 'failed' } })); await settle();
    expect(container.textContent).not.toContain('Pay again');
    expect(h.request).toHaveBeenCalledTimes(3);
  });
  it('shows a current verification failure and permits a later resume to recover', async () => {
    h.request.mockResolvedValueOnce(detail('payment_pending')).mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ payment: { outcome: 'captured' } }).mockResolvedValueOnce(detail('preparing'));
    await render();
    expect(container.textContent).toContain('Could not check this payment.');
    expect(container.textContent).toContain('Check payment');
    await appState('background'); await appState('active');
    expect(container.textContent).toContain('Server: preparing');
    expect(container.textContent).not.toContain('Could not check this payment.');
  });
  it.each(['ios', 'android'])('%s: keeps current server-authoritative verification and retry wording', async (os) => {
    h.os = os;
    h.request.mockResolvedValueOnce(detail('payment_pending'))
      .mockResolvedValueOnce({ payment: { outcome: 'failed' } }).mockResolvedValueOnce(detail('payment_pending'));
    await render();
    expect(container.textContent).toContain('Server: payment_pending');
    expect(container.textContent).toContain('Pay again');
    expect(h.request.mock.calls.map(([url]) => url)).toEqual([
      '/v1/orders/ORDER-A', '/v1/orders/ORDER-A/payment/verify', '/v1/orders/ORDER-A',
    ]);
  });
  it('preserves Android initial, foreground and timed detail reads', async () => {
    h.os = 'android'; vi.useFakeTimers(); await render();
    expect(h.request).toHaveBeenCalledTimes(1);
    h.request.mockResolvedValue(detail('rider_assigned'));
    await appState('background'); await appState('active');
    expect(container.textContent).toContain('Server: rider_assigned');
    expect(h.request).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(12_000); }); await settle();
    expect(h.request).toHaveBeenCalledTimes(3);
    expect(verifyCalls()).toHaveLength(0);
  });
});
