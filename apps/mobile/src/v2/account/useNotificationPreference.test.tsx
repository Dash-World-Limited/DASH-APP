// @vitest-environment jsdom
/**
 * The notification switch, through the real hook: it reads what this phone
 * stored for the account, writes a flip straight back, keeps it across a
 * reopen, and puts the switch back if the write fails.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  failWrites: false,
  writes: 0,
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.writes += 1;
      if (storage.failWrites) throw new Error('disk full');
      storage.values.set(key, value);
    },
  },
}));

import { useNotificationPreference, type NotificationPreferenceState } from './useNotificationPreference';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let state: NotificationPreferenceState;
let root: Root | null = null;

function Probe({ identityId }: { identityId: string }) {
  state = useNotificationPreference(identityId);
  return null;
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });

async function open(identityId = 'identity-1') {
  root = createRoot(document.createElement('div'));
  await act(async () => root?.render(<Probe identityId={identityId} />));
  await settle();
}

async function close() {
  await act(async () => root?.unmount());
  root = null;
}

beforeEach(() => {
  storage.values.clear();
  storage.failWrites = false;
  storage.writes = 0;
});

afterEach(async () => {
  if (root) await close();
});

describe('notification preference', () => {
  it('opens on, and reading it writes nothing', async () => {
    await open();
    expect(state.enabled).toBe(true);
    expect(state.loadFailed).toBe(false);
    expect(storage.writes).toBe(0);
  });

  it('saves a flip and keeps it when the screen is opened again', async () => {
    await open();
    await act(async () => state.setEnabled(false));
    expect(state.enabled).toBe(false);
    expect(state.saving).toBe(false);
    await close();

    await open();
    expect(state.enabled).toBe(false);
    await act(async () => state.setEnabled(true));
    await close();
    await open();
    expect(state.enabled).toBe(true);
  });

  it('puts the switch back and says so when the phone cannot save it', async () => {
    await open();
    storage.failWrites = true;
    await act(async () => state.setEnabled(false));
    expect(state.enabled).toBe(true);
    expect(state.error).toMatch(/could not be saved/);
  });

  it('ignores a second tap while the first is still saving', async () => {
    await open();
    await act(async () => {
      void state.setEnabled(false);
      void state.setEnabled(false);
    });
    await settle();
    expect(storage.writes).toBe(1);
  });

  it('keeps each account’s choice to itself', async () => {
    await open('identity-1');
    await act(async () => state.setEnabled(false));
    await close();
    await open('identity-2');
    expect(state.enabled).toBe(true);
  });
});
