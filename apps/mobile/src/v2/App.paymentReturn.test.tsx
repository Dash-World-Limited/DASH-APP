// @vitest-environment jsdom
// Real Bootstrap, AuthGate, Navigator and Customer Orders; native UI and unrelated screens are stubbed.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushTarget } from '../features/pushNotifications';

const h = vi.hoisted(() => ({
  os: 'ios', session: 'restoring', mode: 'customer', ready: true,
  initial: vi.fn(), request: vi.fn(), listeners: new Set<(event: { url: string }) => void>(),
  openPush: null as ((target: PushTarget) => void) | null, recall: vi.fn(),
}));
vi.mock('react-native', () => {
  const Box = ({ children, testID }: { children?: ReactNode; testID?: string }) => <div data-testid={testID}>{children}</div>;
  return {
    View: Box, ScrollView: Box, TextInput: () => null, ActivityIndicator: () => <span>Loading</span>, Alert: {},
    Pressable: ({ children, onPress, accessibilityLabel }: { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string }) => <button aria-label={accessibilityLabel} onClick={onPress}>{children}</button>,
    Platform: { get OS() { return h.os; } },
    Linking: { getInitialURL: () => h.initial(), addEventListener: (_: string, listener: (event: { url: string }) => void) => { h.listeners.add(listener); return { remove: () => h.listeners.delete(listener) }; } },
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  };
});
vi.mock('react-native-safe-area-context', () => {
  const Box = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { SafeAreaView: Box, SafeAreaProvider: Box };
});
vi.mock('@expo-google-fonts/manrope', () => ({
  Manrope_400Regular: 1, Manrope_500Medium: 1, Manrope_600SemiBold: 1, Manrope_700Bold: 1, Manrope_800ExtraBold: 1,
  useFonts: () => [h.ready, null],
}));
vi.mock('expo-splash-screen', () => ({ preventAutoHideAsync: async () => undefined, hideAsync: async () => undefined }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('../api', () => ({ api: { configured: true, request: h.request }, ApiError: class extends Error {} }));
vi.mock('../theme/ThemeProvider', () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children, useTheme: () => ({ ready: true, palette: {} }) }));
vi.mock('../features/ModeProvider', () => ({ ModeProvider: ({ children }: { children: ReactNode }) => children, useAppMode: () => ({ ready: true, mode: h.mode, setMode: (mode: string) => { h.mode = mode; } }) }));
vi.mock('../features/CartProvider', () => ({ CartProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('./auth/AppSessionProvider', () => ({
  AppSessionProvider: ({ children }: { children: ReactNode }) => children,
  useAppSession: () => ({ state: h.session, configured: true, viewer: h.session === 'authenticated' ? { identity: { name: 'Test Customer', email: 'test@example.test' }, riderStatus: 'approved' } : null }),
}));
vi.mock('./rider/RiderFlowProvider', () => ({
  RiderFlowProvider: ({ children }: { children: ReactNode }) => children,
  useRiderFlow: () => ({ online: true, deliveryRestored: true, delivery: { id: 'assigned', code: 'TEST-RIDER', status: 'en_route', branch: { name: 'Test shop' } } }),
}));
vi.mock('./push/usePushNotifications', () => ({ usePushNotifications: ({ onOpen }: { onOpen: (target: PushTarget) => void }) => { h.openPush = onOpen; } }));
vi.mock('./orders/useDeliveryLocation', () => ({ useDeliveryLocation: () => ({ location: { kind: 'unavailable' } }) }));
vi.mock('../ui/Text', () => ({ Text: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock('../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../brand/Wordmark', () => ({ Wordmark: () => null }));
vi.mock('../rider/MapShell', () => ({ MapShell: () => null }));
vi.mock('../features/orderMemory', () => ({ recallOrder: h.recall, rememberOrder: async () => undefined }));
vi.mock('./orders/parts', () => {
  const Box = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  const Button = ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => <button disabled={disabled} onClick={onPress}>{label}</button>;
  return { OrderPage: Box, Card: Box, BackHeader: ({ title, onBack }: { title: string; onBack: () => void }) => <><h1>{title}</h1><button onClick={onBack}>Back</button></>, Notice: ({ text }: { text: string }) => <p>{text}</p>, Empty: ({ title }: { title: string }) => <p>{title}</p>, PrimaryCheckoutButton: Button, SecondaryButton: Button };
});
vi.mock('../../assets/fonts/DashNairaSign-400.ttf', () => ({ default: 1 }));
vi.mock('../../assets/fonts/DashNairaSign-500.ttf', () => ({ default: 1 }));
vi.mock('../../assets/fonts/DashNairaSign-600.ttf', () => ({ default: 1 }));
vi.mock('../../assets/fonts/DashNairaSign-700.ttf', () => ({ default: 1 }));
vi.mock('../../assets/fonts/DashNairaSign-800.ttf', () => ({ default: 1 }));
vi.mock('./artwork/CategoryPhoto', () => ({ CategoryPhoto: () => null }));
vi.mock('./auth/AccountSessionCard', () => ({ AccountSessionCard: () => null }));
vi.mock('./auth/RegisterScreen', () => ({ RegisterScreen: () => null }));
vi.mock('./account/DeleteAccountScreen', () => ({ DeleteAccountScreen: () => null }));
vi.mock('./account/NotificationSettingsScreen', () => ({ NotificationSettingsScreen: () => null }));
vi.mock('./account/PersonalDetailsScreen', () => ({ PersonalDetailsScreen: () => null }));
vi.mock('./account/BankAccountScreen', () => ({ BankAccountScreen: () => null }));
vi.mock('./account/SupportChatScreen', () => ({ SupportChatScreen: () => null }));
vi.mock('./account/SavedAddressesScreen', () => ({ SavedAddressesScreen: () => null }));
vi.mock('./account/SettingsList', () => ({ SettingsItem: () => null, SettingsSection: () => null }));
vi.mock('./account/SupportScreen', () => ({ SupportScreen: () => null }));
vi.mock('./legal/LegalScreen', () => ({ LegalScreen: () => null }));
vi.mock('./wallet/WalletScreen', () => ({ WalletScreen: () => null }));
vi.mock('./rider/RiderApplyScreen', () => ({ RiderApplyScreen: () => null }));
vi.mock('./declutter/DeclutterScreens', () => ({ DeclutterListingScreen: () => null }));
vi.mock('./catalog/CatalogScreens', () => ({ CartScreen: () => null, CategoryDashboard: () => null, CustomerSearchScreen: () => null, ProductDetail: () => null, Storefront: () => null }));
vi.mock('./orders/CheckoutScreen', () => ({ CustomerCheckoutScreen: () => null }));
vi.mock('./chat/OrderChatScreen', () => ({ OrderChatScreen: () => null }));
vi.mock('./orders/DeliveryLocationScreen', () => ({ DeliveryLocationScreen: () => null }));
vi.mock('./orders/RateRiderCard', () => ({ RateRiderCard: () => null }));
vi.mock('./rider/RiderScreens', () => ({ RiderHistoryDetailScreen: () => null, RiderOfferBanner: () => null, RiderOrdersScreen: () => null, RiderWorkspace: () => <span>Rider workspace</span> }));

import DashApp from './App';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const settle = () => act(async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); });
async function render() { await act(async () => root.render(<DashApp />)); await settle(); }
async function emit(url = 'dash://orders') { await act(async () => { for (const listener of h.listeners) listener({ url }); }); await settle(); }
async function session(state: string) { h.session = state; await render(); }
const isHome = () => container.querySelector('[data-testid="customer-home-v2"]') !== null;
beforeEach(() => {
  h.os = 'ios'; h.session = 'restoring'; h.mode = 'customer'; h.ready = true; h.listeners.clear();
  h.initial.mockReset().mockResolvedValue(null); h.request.mockReset().mockResolvedValue({ orders: [] });
  h.openPush = null; h.recall.mockReset().mockResolvedValue({});
  container = document.createElement('div'); root = createRoot(container);
});

const detail = (id: string, status = 'preparing') => ({ order: {
  id, code: id, status, statusLabel: `Server: ${status}`, phase: status,
  total: 10000, itemsSubtotal: 10000, discountTotal: 0, deliveryFee: 0, serviceFee: 0,
  smallOrderFee: 0, surgeAmount: 0, tax: 0, tip: 0, createdAt: '2026-10-20T10:00:00Z',
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
async function openOrder(id: string) {
  await act(async () => h.openPush!({ face: 'customer', routes: [{ name: 'customer.track-order', params: { id } }] }));
  await settle();
}

describe('iOS order detail identity through real notification navigation', () => {
  it('does not expose the previous order, PIN or payment controls while the newly opened order loads', async () => {
    h.session = 'authenticated';
    const next = deferred<ReturnType<typeof detail>>();
    h.request.mockResolvedValueOnce(detail('ORDER-A', 'payment_pending'))
      .mockResolvedValueOnce({ payment: { outcome: 'failed' } })
      .mockResolvedValueOnce(detail('ORDER-A', 'payment_pending'))
      .mockImplementationOnce(() => next.promise);
    h.recall.mockResolvedValueOnce({ deliveryPin: '1111' }).mockImplementationOnce(() => new Promise(() => undefined));
    await render(); await openOrder('ORDER-A');
    expect(container.textContent).toContain('Order ORDER-A');
    expect(container.textContent).toContain('1111');
    expect(container.textContent).toContain('Pay again');
    await openOrder('ORDER-B');
    expect(container.textContent).toContain('Loading');
    expect(container.textContent).not.toContain('Order ORDER-A');
    expect(container.textContent).not.toContain('1111');
    expect(container.textContent).not.toContain('Pay again');
    expect(container.textContent).not.toContain('Cancel this order');
    await act(async () => next.resolve(detail('ORDER-B'))); await settle();
    expect(container.textContent).toContain('Order ORDER-B');
    expect(container.textContent).not.toContain('Payment did not go through');
    expect(container.textContent).not.toContain('1111');
  });
  it('shows a failed new-order read instead of retaining the previous order and its actions', async () => {
    h.session = 'authenticated';
    h.request.mockResolvedValueOnce(detail('ORDER-A')).mockRejectedValueOnce(new Error('offline'));
    await render(); await openOrder('ORDER-A'); await openOrder('ORDER-B');
    expect(container.textContent).toContain('Tracking unavailable');
    expect(container.textContent).not.toContain('Order ORDER-A');
  });
  it('does not remount or refetch on a repeated notification for the currently open order', async () => {
    h.session = 'authenticated'; h.request.mockResolvedValue(detail('ORDER-A'));
    h.recall.mockResolvedValue({ deliveryPin: '1111' });
    await render(); await openOrder('ORDER-A'); await openOrder('ORDER-A');
    expect(container.textContent).toContain('Order ORDER-A');
    expect(container.textContent).toContain('1111');
    expect(h.request).toHaveBeenCalledExactlyOnceWith('/v1/orders/ORDER-A');
    expect(h.recall).toHaveBeenCalledTimes(1);
  });
  it('loads the original order afresh on Back without displaying the newer order during restoration', async () => {
    h.session = 'authenticated';
    const backRead = deferred<ReturnType<typeof detail>>();
    h.request.mockResolvedValueOnce(detail('ORDER-A')).mockResolvedValueOnce(detail('ORDER-B'))
      .mockImplementationOnce(() => backRead.promise);
    await render(); await openOrder('ORDER-A'); await openOrder('ORDER-B');
    const back = [...container.querySelectorAll('button')].find(node => node.textContent === 'Back');
    expect(back).toBeDefined();
    await act(async () => back!.click()); await settle();
    expect(container.textContent).toContain('Loading');
    expect(container.textContent).not.toContain('Order ORDER-B');
    await act(async () => backRead.resolve(detail('ORDER-A', 'delivered'))); await settle();
    expect(container.textContent).toContain('Order ORDER-A');
    expect(container.textContent).toContain('Server: delivered');
    expect(h.request.mock.calls.map(([url]) => url)).toEqual(['/v1/orders/ORDER-A', '/v1/orders/ORDER-B', '/v1/orders/ORDER-A']);
  });
  it('discards the old screen read after notification navigation without verifying its obsolete pending payment', async () => {
    h.session = 'authenticated';
    const old = deferred<ReturnType<typeof detail>>();
    h.request.mockImplementationOnce(() => old.promise).mockResolvedValueOnce(detail('ORDER-B'));
    await render(); await openOrder('ORDER-A'); await openOrder('ORDER-B');
    await act(async () => old.resolve(detail('ORDER-A', 'payment_pending'))); await settle();
    expect(container.textContent).toContain('Order ORDER-B');
    expect(container.textContent).not.toContain('Order ORDER-A');
    expect(h.request).toHaveBeenCalledTimes(2);
  });
  it('does not open a Customer order notification over an active Rider workspace', async () => {
    h.session = 'authenticated'; h.mode = 'rider'; await render();
    const resume = [...container.querySelectorAll('button')].find(node => node.textContent === 'Continue delivery');
    expect(resume).toBeDefined();
    await act(async () => resume!.click()); await settle();
    await openOrder('ORDER-A');
    expect(container.textContent).toContain('Rider workspace');
    expect(h.mode).toBe('rider');
    expect(h.request.mock.calls.some(([url]) => String(url).startsWith('/v1/orders/'))).toBe(false);
  });
  it('preserves Android server reads and duplicate-target behavior', async () => {
    h.os = 'android'; h.session = 'authenticated';
    h.request.mockResolvedValueOnce(detail('ORDER-A')).mockResolvedValueOnce(detail('ORDER-B'));
    await render(); await openOrder('ORDER-A'); await openOrder('ORDER-B'); await openOrder('ORDER-B');
    expect(container.textContent).toContain('Order ORDER-B');
    expect(h.request.mock.calls.map(([url]) => url)).toEqual(['/v1/orders/ORDER-A', '/v1/orders/ORDER-B']);
    expect(h.initial).not.toHaveBeenCalled();
    expect(h.listeners.size).toBe(0);
  });
});
afterEach(async () => { await act(async () => root.unmount()); });

describe('iOS payment return across the real authentication gate', () => {
  it.each(['restoring', 'unauthenticated'])('retains a warm return while %s and opens Orders only after authentication', async (state) => {
    h.session = state; await render(); await emit();
    expect(h.request).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('No active delivery');
    await session('authenticated');
    expect(container.textContent).toContain('No active delivery');
    expect(h.request).toHaveBeenCalledExactlyOnceWith('/v1/orders?status=active&limit=20');
  });
  it('does not replay a consumed cold URL when navigation remounts after logout/login', async () => {
    h.initial.mockResolvedValue('dash://orders');
    await render(); await session('authenticated');
    expect(container.textContent).toContain('No active delivery');
    await session('unauthenticated'); await session('authenticated');
    expect(isHome()).toBe(true);
    expect(h.initial).toHaveBeenCalledTimes(1);
    expect(h.request).toHaveBeenCalledTimes(1);
  });
  it('captures a warm return while fonts are still loading', async () => {
    h.ready = false; await render(); await emit();
    h.ready = true; await session('authenticated');
    expect(container.textContent).toContain('No active delivery');
  });
  it('coalesces pending duplicates and ignores forged success/order parameters', async () => {
    await render(); await emit('dash://orders?status=success&orderId=forged'); await emit('dash://orders?status=success&orderId=forged');
    expect(h.request).not.toHaveBeenCalled();
    await session('authenticated');
    expect(container.textContent).toContain('No active delivery');
    await emit('dash://orders?status=success&orderId=forged');
    expect(h.request).toHaveBeenCalledExactlyOnceWith('/v1/orders?status=active&limit=20');
    expect(container.textContent).toContain('No active delivery');
  });
  it('retains a cold return through a signed-out launch without reading account data early', async () => {
    h.session = 'unauthenticated'; h.initial.mockResolvedValue('dash://orders');
    await render();
    expect(h.request).not.toHaveBeenCalled();
    await session('authenticated');
    expect(container.textContent).toContain('No active delivery');
    expect(h.request).toHaveBeenCalledExactlyOnceWith('/v1/orders?status=active&limit=20');
  });
  it('uses server-owned pending status on a warm return and allows a later legitimate return', async () => {
    h.session = 'authenticated';
    h.request.mockResolvedValue({ orders: [{
      id: 'server-order', code: 'SERVER-ORDER', status: 'payment_pending', statusLabel: 'Awaiting payment',
      phase: 'payment', total: 10000, createdAt: '2026-10-19T10:00:00Z',
      vendor: { name: 'Test shop', slug: 'test', category: 'food' }, items: [],
    }] });
    await render(); await emit('dash://orders?status=success&orderId=forged');
    expect(container.textContent).toContain('SERVER-ORDER');
    expect(container.textContent).toContain('Awaiting payment');
    expect(h.request).toHaveBeenCalledExactlyOnceWith('/v1/orders?status=active&limit=20');
    const home = [...container.querySelectorAll('button')].find(node => node.textContent === 'Home');
    expect(home).toBeDefined();
    await act(async () => home!.click()); await settle();
    expect(isHome()).toBe(true);
    await emit('dash://orders?status=success&orderId=forged');
    expect(container.textContent).toContain('Awaiting payment');
    expect(h.request).toHaveBeenCalledTimes(2);
  });
  it('keeps an active Rider workspace open during a warm browser return', async () => {
    h.session = 'authenticated'; h.mode = 'rider'; await render();
    const resume = [...container.querySelectorAll('button')].find(node => node.textContent === 'Continue delivery');
    expect(resume).toBeDefined();
    await act(async () => resume!.click()); await settle();
    expect(container.textContent).toContain('Rider workspace');
    await emit();
    expect(container.textContent).toContain('Rider workspace');
    expect(h.mode).toBe('rider');
    expect(h.request.mock.calls.some(([url]) => String(url).startsWith('/v1/orders?'))).toBe(false);
  });
  it('preserves Rider mode and consumes its return instead of replaying at a later Customer login', async () => {
    h.mode = 'rider'; await render(); await emit(); await session('authenticated');
    expect(h.mode).toBe('rider');
    expect(h.request.mock.calls.some(([url]) => String(url).startsWith('/v1/orders?'))).toBe(false);
    await session('unauthenticated'); h.mode = 'customer'; await session('authenticated');
    expect(isHome()).toBe(true);
  });
  it('leaves Android startup and link listeners unchanged', async () => {
    h.os = 'android'; await render(); await emit(); await session('authenticated');
    expect(h.initial).not.toHaveBeenCalled(); expect(h.listeners.size).toBe(0); expect(isHome()).toBe(true);
  });
});
