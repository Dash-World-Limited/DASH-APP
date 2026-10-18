import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ permission: vi.fn(), position: vi.fn() }));
vi.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  requestForegroundPermissionsAsync: h.permission,
  getCurrentPositionAsync: h.position,
}));
vi.mock('react-native', () => ({ Linking: { openSettings: vi.fn() } }));
import { currentLocation, PLACE_FIX_TIMEOUT_MS } from './deviceLocation';

beforeEach(() => {
  vi.useFakeTimers();
  h.permission.mockReset().mockResolvedValue({ status: 'granted', canAskAgain: true });
  h.position.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('delivery address current location', () => {
  it('ends a stalled native GPS fix so the address form can offer retry', async () => {
    h.position.mockImplementation(() => new Promise(() => undefined));
    const result = currentLocation();
    await vi.advanceTimersByTimeAsync(PLACE_FIX_TIMEOUT_MS);
    await expect(result).resolves.toMatchObject({ ok: false, reason: 'unavailable', canAskAgain: true });
  });
  it('keeps approximate iOS coordinates and accuracy without pretending precision', async () => {
    h.position.mockResolvedValue({ coords: { latitude: 6.2, longitude: 6.7, accuracy: 1500 } });
    await expect(currentLocation()).resolves.toEqual({ ok: true, latitude: 6.2, longitude: 6.7, accuracyMetres: 1500 });
  });
  it('does not read GPS after a permanent/restricted permission refusal', async () => {
    h.permission.mockResolvedValue({ status: 'denied', canAskAgain: false });
    await expect(currentLocation()).resolves.toMatchObject({ ok: false, reason: 'denied', canAskAgain: false });
    expect(h.position).not.toHaveBeenCalled();
  });
  it('handles a native location rejection without inventing coordinates', async () => {
    h.position.mockRejectedValue(new Error('location unavailable'));
    await expect(currentLocation()).resolves.toMatchObject({ ok: false, reason: 'unavailable' });
  });
});
