import { describe, expect, it, vi } from 'vitest';

import { createForegroundPermission } from './locationPermission';

const GRANTED = { granted: true, canAskAgain: true };
const MISSING = { granted: false, canAskAgain: true };
const BLOCKED = { granted: false, canAskAgain: false };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeLocation(state: { granted: boolean; canAskAgain: boolean }, answer = true) {
  const location = {
    current: state,
    getForegroundPermissionsAsync: vi.fn(async () => location.current),
    requestForegroundPermissionsAsync: vi.fn(async () => {
      location.current = { granted: answer, canAskAgain: answer };
      return { granted: answer };
    }),
  };
  return location;
}

describe('foreground location permission', () => {
  it('never opens the system request when the permission is already granted', async () => {
    const location = fakeLocation(GRANTED);
    const permission = createForegroundPermission(location);
    expect(await permission.check()).toBe(true);
    expect(await permission.ensure()).toBe(true);
    expect(location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('only reads when checking, even if the permission is missing', async () => {
    const location = fakeLocation(MISSING);
    expect(await createForegroundPermission(location).check()).toBe(false);
    expect(location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('asks once when ensuring a missing permission', async () => {
    const location = fakeLocation(MISSING);
    expect(await createForegroundPermission(location).ensure()).toBe(true);
    expect(location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('does not ask when Android will no longer show the dialog', async () => {
    const location = fakeLocation(BLOCKED);
    expect(await createForegroundPermission(location).ensure()).toBe(false);
    expect(location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('shares one request between concurrent callers', async () => {
    const location = fakeLocation(MISSING);
    const answer = deferred<{ granted: boolean }>();
    location.requestForegroundPermissionsAsync.mockImplementation(() => answer.promise);
    const permission = createForegroundPermission(location);

    const calls = [permission.ensure(), permission.ensure(), permission.check(), permission.ensure()];
    await vi.waitFor(() => expect(location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1));
    answer.resolve({ granted: true });

    expect(await Promise.all(calls)).toEqual([true, true, true, true]);
    expect(location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(location.getForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('shares one read between concurrent checks', async () => {
    const location = fakeLocation(GRANTED);
    const read = deferred<typeof GRANTED>();
    location.getForegroundPermissionsAsync.mockImplementation(() => read.promise);
    const permission = createForegroundPermission(location);

    const calls = [permission.check(), permission.check(), permission.check()];
    read.resolve(GRANTED);
    expect(await Promise.all(calls)).toEqual([true, true, true]);
    expect(location.getForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('lets a silent check finish before an ensure decides to ask, and then asks once', async () => {
    const location = fakeLocation(MISSING);
    const read = deferred<typeof MISSING>();
    location.getForegroundPermissionsAsync.mockImplementationOnce(() => read.promise);
    const permission = createForegroundPermission(location);

    const check = permission.check();
    const ensures = [permission.ensure(), permission.ensure()];
    expect(location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    read.resolve(MISSING);

    expect(await check).toBe(false);
    expect(await Promise.all(ensures)).toEqual([true, true]);
    expect(location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('does not ask after a silent check that found the permission granted', async () => {
    const location = fakeLocation(GRANTED);
    const permission = createForegroundPermission(location);
    const [check, ensure] = [permission.check(), permission.ensure()];
    expect(await check).toBe(true);
    expect(await ensure).toBe(true);
    expect(location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('recovers from a failed read instead of staying stuck in flight', async () => {
    const location = fakeLocation(GRANTED);
    location.getForegroundPermissionsAsync.mockRejectedValueOnce(new Error('location services unavailable'));
    const permission = createForegroundPermission(location);
    await expect(permission.check()).rejects.toThrow('location services unavailable');
    expect(await permission.check()).toBe(true);
  });
});
