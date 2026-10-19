// @vitest-environment jsdom
/**
 * The home screen's delivery location, through the real hook and detection
 * with expo-location faked.
 *
 * What matters: a chosen default address wins and costs no GPS or dialog; the
 * permission is read before it is ever asked for, asked for at most once a
 * session from the home screen, and only re-asked when the customer taps; a
 * fix that never arrives ends; and nothing fake is shown when location is off.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  permission: { status: 'granted', canAskAgain: true } as { status: string; canAskAgain: boolean },
  afterRequest: { status: 'granted', canAskAgain: true } as { status: string; canAskAgain: boolean },
  reads: 0,
  requests: 0,
  fixes: 0,
  hangFix: false,
  places: [{ street: 'Nnebisi Road', streetNumber: '4', city: 'Asaba', region: 'Delta', country: 'Nigeria' }] as unknown[],
  addresses: [] as unknown[],
  session: { state: 'authenticated' as string },
  os: 'android',
  appState: 'active',
  listeners: new Set<(state: string) => void>(),
  delayedFix: null as null | (() => Promise<unknown>),
}));

vi.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  getForegroundPermissionsAsync: async () => {
    h.reads += 1;
    return h.permission;
  },
  requestForegroundPermissionsAsync: async () => {
    h.requests += 1;
    h.permission = h.afterRequest;
    return h.permission;
  },
  getCurrentPositionAsync: () => {
    h.fixes += 1;
    if (h.delayedFix) return h.delayedFix();
    if (h.hangFix) return new Promise(() => undefined);
    return Promise.resolve({ coords: { latitude: 6.2, longitude: 6.7, accuracy: 12 } });
  },
  reverseGeocodeAsync: async () => h.places,
}));
vi.mock('react-native', () => ({
  Linking: { openSettings: async () => undefined },
  Platform: { get OS() { return h.os; } },
  AppState: {
    get currentState() { return h.appState; },
    addEventListener: (_type: string, listener: (state: string) => void) => {
      h.listeners.add(listener);
      return { remove: () => h.listeners.delete(listener) };
    },
  },
}));
vi.mock('../../api', () => ({
  api: { configured: true, request: async () => ({ addresses: h.addresses }) },
}));
vi.mock('../auth/AppSessionProvider', () => ({ useAppSession: () => h.session }));

import { detectCurrentPlace, PLACE_FIX_TIMEOUT_MS } from '../../features/deviceLocation';
import type { HomeLocation } from '../../features/delivery';
import { detectPlace, recentDetection, resetDeliveryLocationSession, resumePlaceDetection, useDeliveryLocation } from './useDeliveryLocation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let location: HomeLocation;
let root: Root | null = null;

function Probe() {
  location = useDeliveryLocation().location;
  return null;
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });

async function openHome() {
  root = createRoot(document.createElement('div'));
  await act(async () => root?.render(<Probe />));
  await settle();
}

async function closeHome() {
  await act(async () => root?.unmount());
  root = null;
}

beforeEach(() => {
  resetDeliveryLocationSession();
  h.permission = { status: 'granted', canAskAgain: true };
  h.afterRequest = { status: 'granted', canAskAgain: true };
  h.reads = 0;
  h.requests = 0;
  h.fixes = 0;
  h.hangFix = false;
  h.places = [{ street: 'Nnebisi Road', streetNumber: '4', city: 'Asaba', region: 'Delta', country: 'Nigeria' }];
  h.addresses = [];
  h.session = { state: 'authenticated' };
  h.os = 'android';
  h.appState = 'active';
  h.listeners.clear();
  h.delayedFix = null;
});

async function changeAppState(state: string) {
  await act(async () => {
    h.appState = state;
    for (const listener of h.listeners) listener(state);
  });
  await settle();
}

describe('iOS Settings recovery', () => {
  beforeEach(() => { h.os = 'ios'; });

  it('refreshes a cached denial after Settings grants access without another prompt', async () => {
    h.permission = { status: 'denied', canAskAgain: false };
    await openHome();
    expect(location.kind).toBe('denied');
    await changeAppState('background');
    h.permission = { status: 'granted', canAskAgain: true };
    await changeAppState('active');
    expect(location.kind).toBe('detected');
    expect(h.requests).toBe(0);
    expect(h.fixes).toBe(1);
  });

  it('discards cached coordinates when Settings revokes access', async () => {
    await openHome();
    await changeAppState('background');
    h.permission = { status: 'denied', canAskAgain: false };
    await changeAppState('active');
    expect(location).toEqual({ kind: 'denied', canAskAgain: false });
    expect(recentDetection()).toMatchObject({ ok: false, reason: 'denied' });
    expect(h.fixes).toBe(1);
    expect(h.requests).toBe(0);
  });

  it('does not prompt for an undetermined permission on resume', async () => {
    h.permission = { status: 'denied', canAskAgain: false };
    await openHome();
    await changeAppState('background');
    h.permission = { status: 'undetermined', canAskAgain: true };
    await changeAppState('active');
    expect(location).toEqual({ kind: 'denied', canAskAgain: true });
    expect(h.requests).toBe(0);
    expect(h.fixes).toBe(0);
  });

  it('ignores inactive/active permission-dialog transitions and duplicate active events', async () => {
    await openHome();
    await changeAppState('inactive');
    await changeAppState('active');
    await changeAppState('active');
    expect(h.reads).toBe(1);
    expect(h.fixes).toBe(1);
  });

  it('preserves the saved default address without GPS on resume', async () => {
    h.addresses = [{ id: 'home', label: 'Home', line1: 'Saved address', isDefault: true }];
    await openHome();
    await changeAppState('background');
    await changeAppState('active');
    expect(location.kind).toBe('confirmed');
    expect(h.reads + h.requests + h.fixes).toBe(0);
  });

  it('invalidates cached coordinates on iOS resume even when a saved default wins', async () => {
    await detectPlace({ ask: false });
    expect(recentDetection()?.ok).toBe(true);
    h.addresses = [{ id: 'home', label: 'Home', line1: 'Saved address', isDefault: true }];
    await openHome();
    await changeAppState('background');
    h.permission = { status: 'denied', canAskAgain: false };
    await changeAppState('active');
    expect(location.kind).toBe('confirmed');
    expect(h.reads).toBe(1);
    expect(h.fixes).toBe(1);
    expect(recentDetection()).toBeNull();
    // The next location-screen detection must read the new permission.
    await expect(detectPlace({ ask: false })).resolves.toMatchObject({ ok: false, reason: 'denied' });
    expect(h.reads).toBe(2);
    expect(h.requests).toBe(0);
    expect(h.fixes).toBe(1);
  });

  it('prevents an old pending fix from repopulating the cache after saved-address resume', async () => {
    let complete!: (value: unknown) => void;
    h.delayedFix = () => new Promise((resolve) => { complete = resolve; });
    const old = detectPlace({ ask: false });
    await settle();
    h.addresses = [{ id: 'home', label: 'Home', line1: 'Saved address', isDefault: true }];
    await openHome();
    await changeAppState('background');
    await changeAppState('active');
    complete({ coords: { latitude: 6.2, longitude: 6.7, accuracy: 12 } });
    await old;
    expect(recentDetection()).toBeNull();
    expect(location.kind).toBe('confirmed');
    expect(h.fixes).toBe(1);
  });

  it('retains Android cached coordinates across saved-address resume', async () => {
    h.os = 'android';
    await detectPlace({ ask: false });
    h.addresses = [{ id: 'home', label: 'Home', line1: 'Saved address', isDefault: true }];
    await openHome();
    await changeAppState('background');
    await changeAppState('active');
    expect(recentDetection()?.ok).toBe(true);
    expect(h.reads).toBe(1);
    expect(h.fixes).toBe(1);
  });

  it('keeps Android resume behavior unchanged and removes the iOS listener on unmount', async () => {
    h.os = 'android';
    await openHome();
    expect(h.listeners.size).toBe(0);
    await closeHome();
    h.os = 'ios';
    await openHome();
    expect(h.listeners.size).toBe(1);
    await closeHome();
    expect(h.listeners.size).toBe(0);
  });

  it('does not let a late pre-background fix overwrite a post-resume denial', async () => {
    let complete!: (value: unknown) => void;
    h.delayedFix = () => new Promise((resolve) => { complete = resolve; });
    const old = detectPlace({ ask: false });
    await settle();
    h.permission = { status: 'denied', canAskAgain: false };
    await expect(resumePlaceDetection()).resolves.toMatchObject({ ok: false, reason: 'denied' });
    complete({ coords: { latitude: 6.2, longitude: 6.7, accuracy: 12 } });
    await old;
    expect(recentDetection()).toMatchObject({ ok: false, reason: 'denied' });
  });
});

afterEach(async () => {
  if (root) await closeHome();
  vi.useRealTimers();
});

describe('home screen delivery location', () => {
  it('shows the default saved address and never touches GPS for it', async () => {
    h.addresses = [
      { id: 'a1', label: null, line1: '9 Old Road', isDefault: false },
      { id: 'a2', label: 'Home', line1: '4 Nnebisi Road', isDefault: true },
    ];
    await openHome();
    expect(location).toEqual({ kind: 'confirmed', label: 'Home', line1: '4 Nnebisi Road' });
    expect(h.reads + h.requests + h.fixes).toBe(0);
  });

  it('shows the real detected address when nothing is chosen yet', async () => {
    await openHome();
    expect(location).toEqual({ kind: 'detected', description: '4 Nnebisi Road, Asaba, Delta' });
    expect(h.requests).toBe(0);
    expect(h.fixes).toBe(1);
  });

  it('asks for permission once a session, and reuses the fix on return', async () => {
    h.permission = { status: 'undetermined', canAskAgain: true };
    await openHome();
    expect(h.requests).toBe(1);
    expect(location.kind).toBe('detected');
    await closeHome();
    await openHome();
    expect(h.requests).toBe(1);
    expect(h.fixes).toBe(1);
  });

  it('shows a clean fallback, not a fake place, when permission is refused', async () => {
    h.permission = { status: 'undetermined', canAskAgain: true };
    h.afterRequest = { status: 'denied', canAskAgain: false };
    await openHome();
    expect(location).toEqual({ kind: 'denied', canAskAgain: false });
    expect(h.fixes).toBe(0);
    await closeHome();
    await openHome();
    expect(h.requests).toBe(1);
  });

  it('never re-asks someone who said no, until they tap', async () => {
    h.permission = { status: 'denied', canAskAgain: true };
    await openHome();
    expect(location).toEqual({ kind: 'denied', canAskAgain: true });
    expect(h.requests).toBe(0);
    await closeHome();
    await openHome();
    expect(h.requests).toBe(0);

    h.afterRequest = { status: 'granted', canAskAgain: true };
    const tapped = await detectPlace({ ask: true, fresh: true });
    expect(h.requests).toBe(1);
    expect(tapped.ok).toBe(true);
  });

  it('keeps the position when the geocoder has no address for it', async () => {
    h.places = [];
    await openHome();
    expect(location).toEqual({ kind: 'detected', description: null });
  });

  it('works for a signed-out visitor from GPS alone', async () => {
    h.session = { state: 'unauthenticated' };
    await openHome();
    expect(location.kind).toBe('detected');
  });
});

describe('detecting the current place', () => {
  it('never opens the permission dialog unless allowed to', async () => {
    h.permission = { status: 'undetermined', canAskAgain: true };
    const result = await detectCurrentPlace({ ask: 'never' });
    expect(result).toMatchObject({ ok: false, reason: 'denied', canAskAgain: true });
    expect(h.requests).toBe(0);
    expect(h.reads).toBe(1);

    h.permission = { status: 'denied', canAskAgain: true };
    await detectCurrentPlace({ ask: 'first-time' });
    expect(h.requests).toBe(0);
    await detectCurrentPlace({ ask: 'always' });
    expect(h.requests).toBe(1);
  });

  it('does not ask once Android can no longer ask', async () => {
    h.permission = { status: 'denied', canAskAgain: false };
    const result = await detectCurrentPlace({ ask: 'always' });
    expect(result).toMatchObject({ ok: false, reason: 'denied', canAskAgain: false });
    expect(h.requests).toBe(0);
  });

  it('does not re-request a permission already granted', async () => {
    const result = await detectCurrentPlace({ ask: 'always' });
    expect(result).toMatchObject({ ok: true, latitude: 6.2, longitude: 6.7 });
    expect(h.requests).toBe(0);
  });

  it('gives up on a fix that never arrives', async () => {
    vi.useFakeTimers();
    h.hangFix = true;
    const pending = detectCurrentPlace({ ask: 'never' });
    await vi.advanceTimersByTimeAsync(PLACE_FIX_TIMEOUT_MS + 1);
    await expect(pending).resolves.toMatchObject({ ok: false, reason: 'unavailable' });
  });
});
