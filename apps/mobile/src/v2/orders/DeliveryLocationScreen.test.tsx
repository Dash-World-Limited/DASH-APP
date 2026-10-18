// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  os: 'ios', state: 'active', listeners: new Set<(state: string) => void>(),
  permission: { status: 'denied', canAskAgain: false },
  requests: 0, fixes: 0, settings: 0,
  pendingFix: null as null | (() => Promise<unknown>),
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
  Linking: { openSettings: async () => { h.settings += 1; } },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ActivityIndicator: () => <span>Loading</span>,
}));
vi.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  getForegroundPermissionsAsync: async () => h.permission,
  requestForegroundPermissionsAsync: async () => { h.requests += 1; return h.permission; },
  getCurrentPositionAsync: () => {
    h.fixes += 1;
    return h.pendingFix ? h.pendingFix() : Promise.resolve({ coords: { latitude: 6.2, longitude: 6.7, accuracy: 12 } });
  },
  reverseGeocodeAsync: async () => [{ street: 'Nnebisi Road', city: 'Asaba' }],
}));
vi.mock('../../api', () => ({ api: { configured: true }, ApiError: class extends Error {} }));
vi.mock('../../data/orders', () => ({ listAddresses: async () => [], updateAddress: vi.fn() }));
vi.mock('../auth/AppSessionProvider', () => ({
  useAppSession: () => ({ state: 'authenticated', viewer: { identity: { phone: '' } } }),
}));
vi.mock('../../theme/ThemeProvider', () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock('../../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../../ui/Text', () => ({ Text: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock('./parts', () => {
  const Box = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  const Button = ({ label, onPress }: { label: string; onPress: () => void }) => <button onClick={onPress}>{label}</button>;
  return {
    OrderPage: Box, Card: Box, BackHeader: () => null, Empty: () => null,
    Notice: ({ text }: { text: string }) => <p>{text}</p>,
    PrimaryCheckoutButton: Button, SecondaryButton: Button,
  };
});
vi.mock('./NewAddressForm', () => ({ NewAddressForm: () => <input aria-label="Address draft" defaultValue="" /> }));

import { DeliveryLocationScreen } from './DeliveryLocationScreen';
import { resetDeliveryLocationSession } from './useDeliveryLocation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const settle = () => act(async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); });
async function mount() {
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(<DeliveryLocationScreen onBack={() => undefined} onAccount={() => undefined} />));
  await settle();
}
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((node) => node.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
  await settle();
}
async function state(next: string) {
  await act(async () => {
    h.state = next;
    for (const listener of h.listeners) listener(next);
  });
  await settle();
}
beforeEach(() => {
  resetDeliveryLocationSession();
  h.os = 'ios'; h.state = 'active'; h.listeners.clear();
  h.permission = { status: 'denied', canAskAgain: false };
  h.requests = 0; h.fixes = 0; h.settings = 0; h.pendingFix = null;
});
afterEach(async () => { await act(async () => root?.unmount()); });

describe('delivery location Settings return on iOS', () => {
  it('recovers from the Open settings action without asking again', async () => {
    await mount();
    await click('Open settings');
    expect(h.settings).toBe(1);
    await state('background');
    h.permission = { status: 'granted', canAskAgain: true };
    await state('active');
    expect(container.textContent).toContain('Nnebisi Road');
    expect(container.textContent).toContain('Use this location');
    expect(h.requests).toBe(0);
  });
  it('removes the detected location action after permission is revoked', async () => {
    h.permission = { status: 'granted', canAskAgain: true };
    await mount();
    await state('background');
    h.permission = { status: 'denied', canAskAgain: false };
    await state('active');
    expect(container.textContent).toContain('Open settings');
    expect(container.textContent).not.toContain('Use this location');
    expect(h.fixes).toBe(1);
  });
  it('keeps the typed address draft and chosen position when switching apps', async () => {
    h.permission = { status: 'granted', canAskAgain: true };
    await mount();
    await click('Use this location');
    const draft = container.querySelector('input')!;
    draft.value = 'My corrected address';
    await state('background');
    await state('active');
    expect(container.querySelector('input')).toBe(draft);
    expect(draft.value).toBe('My corrected address');
    expect(h.fixes).toBe(1);
  });
  it('drops a late pre-background fix instead of replacing the current denial', async () => {
    let finish!: (value: unknown) => void;
    h.permission = { status: 'granted', canAskAgain: true };
    h.pendingFix = () => new Promise((resolve) => { finish = resolve; });
    await mount();
    await state('background');
    h.permission = { status: 'denied', canAskAgain: false };
    await state('active');
    await act(async () => finish({ coords: { latitude: 6.2, longitude: 6.7, accuracy: 12 } }));
    await settle();
    expect(container.textContent).toContain('Open settings');
    expect(container.textContent).not.toContain('Use this location');
  });
  it('ignores inactive/active transitions from the permission dialog', async () => {
    await mount();
    h.permission = { status: 'granted', canAskAgain: true };
    await state('inactive');
    await state('active');
    expect(h.fixes).toBe(0);
    expect(container.textContent).toContain('Open settings');
  });
  it('leaves Android location resume behavior unchanged', async () => {
    h.os = 'android';
    await mount();
    expect(h.listeners.size).toBe(0);
  });
});
