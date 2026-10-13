// @vitest-environment jsdom
/**
 * The rider flow's location lifecycle, through the real provider.
 *
 * Regression for the Samsung A55 loop: requesting foreground location on every
 * return to `active` opened Android's permission activity even with the
 * permission granted; that activity paused and resumed DASH, which reported
 * `active` again, which requested again. The fakes below behave like Android
 * does — every request call pauses and resumes the app — so a request on
 * resume would show up here as a runaway count.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  return {
    listeners,
    location: {
      getForegroundPermissionsAsync: vi.fn(),
      requestForegroundPermissionsAsync: vi.fn(),
      getCurrentPositionAsync: vi.fn(),
      watchPositionAsync: vi.fn(),
    },
    request: vi.fn(),
    session: { state: 'authenticated', viewer: { riderAvailability: 'offline' } },
  };
});

vi.mock('expo-location', () => ({ ...h.location, Accuracy: { High: 4 } }));
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_type: string, listener: (state: string) => void) => {
      h.listeners.add(listener);
      return { remove: () => h.listeners.delete(listener) };
    },
  },
}));
vi.mock('../../api', () => ({
  api: { configured: true, request: h.request },
  ApiError: class ApiError extends Error {},
  buildVariant: 'development',
}));
vi.mock('../auth/AppSessionProvider', () => ({ useAppSession: () => h.session }));

import { RiderFlowProvider, useRiderFlow } from './RiderFlowProvider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LOCATION_REQUIRED = 'Location permission is required while a rider is online.';
const NO_GPS_FIX = 'DASH could not get a GPS fix. Move to open sky, check that Location is on, and try again.';
const GRANTED = { granted: true, canAskAgain: true, status: 'granted' };
const MISSING = { granted: false, canAskAgain: true, status: 'undetermined' };
const BLOCKED = { granted: false, canAskAgain: false, status: 'denied' };

let flow: ReturnType<typeof useRiderFlow>;
let root: Root | null = null;
let permissionState = GRANTED;
let requestAnswer = true;
let watchRemove = vi.fn();

function Probe() {
  flow = useRiderFlow();
  return null;
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 25; i += 1) await Promise.resolve();
  });

async function mount(availability: string) {
  h.session.viewer.riderAvailability = availability;
  root = createRoot(document.createElement('div'));
  await act(async () => {
    root?.render(
      <RiderFlowProvider>
        <Probe />
      </RiderFlowProvider>,
    );
  });
  await settle();
}

async function appState(next: string) {
  await act(async () => {
    for (const listener of [...h.listeners]) listener(next);
  });
  await settle();
}

/** What Android does around a permission request: DASH's activity pauses and resumes. */
function permissionActivityHop() {
  for (const listener of [...h.listeners]) listener('background');
  for (const listener of [...h.listeners]) listener('active');
}

const posts = (path: string) => h.request.mock.calls.filter(([url]) => url === path);
const fixOptions = () =>
  h.location.getCurrentPositionAsync.mock.calls.map(([options]) => options as { mayShowUserSettingsDialog?: boolean });
/** Fake setTimeout too, for the fix timeout. Install before mounting. */
const fakeAllTimers = () =>
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
const availabilityPosts = () =>
  posts('/v1/rider/availability').map(([, options]) => (options as { body: { availability: string } }).body.availability);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  h.listeners.clear();
  permissionState = GRANTED;
  requestAnswer = true;
  watchRemove = vi.fn();
  h.location.getForegroundPermissionsAsync.mockImplementation(async () => permissionState);
  h.location.requestForegroundPermissionsAsync.mockImplementation(async () => {
    permissionActivityHop();
    permissionState = requestAnswer ? GRANTED : { granted: false, canAskAgain: true, status: 'denied' };
    return permissionState;
  });
  h.location.getCurrentPositionAsync.mockImplementation(async () => ({
    coords: { latitude: 6.4281, longitude: 3.4219, accuracy: 8, heading: null, speed: null },
    timestamp: Date.now(),
  }));
  h.location.watchPositionAsync.mockImplementation(async () => ({ remove: watchRemove }));
  h.request.mockImplementation(async (url: string) => {
    if (url === '/v1/rider/offers') return { offers: [] };
    if (url === '/v1/rider/deliveries') return { deliveries: [] };
    return {};
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  vi.useRealTimers();
});

describe('rider location permission lifecycle', () => {
  it('does not request permission again on AppState resume when it is already granted', async () => {
    await mount('idle');
    expect(flow.online).toBe(true);
    expect(h.location.watchPositionAsync).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(1_000);
      await appState('background');
      await appState('active');
    }

    expect(h.location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    // One fresh fix for the restore and one per return, no more.
    expect(h.location.getCurrentPositionAsync).toHaveBeenCalledTimes(6);
    // The watch is started once and left to expo-location to pause and resume.
    expect(h.location.watchPositionAsync).toHaveBeenCalledTimes(1);
    expect(watchRemove).not.toHaveBeenCalled();
    expect(flow.error).toBeNull();
  });

  it('shares one permission check across overlapping lifecycle events', async () => {
    let release!: () => void;
    h.location.getForegroundPermissionsAsync.mockImplementation(
      () => new Promise((done) => {
        release = () => done(GRANTED);
      }),
    );

    // Restoring a working rider starts the fresh-fix report and the watch
    // together; three returns to the app land while the check is still open.
    await mount('idle');
    await appState('active');
    await appState('active');
    await appState('active');

    expect(h.location.getForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    await act(async () => release());
    await settle();

    expect(h.location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(h.location.watchPositionAsync).toHaveBeenCalledTimes(1);
    // The overlapping fresh-fix reports joined the one already in flight.
    expect(h.location.getCurrentPositionAsync).toHaveBeenCalledTimes(1);
  });

  it('opens one permission dialog for concurrent Go online taps', async () => {
    permissionState = MISSING;
    let answer!: () => void;
    h.location.requestForegroundPermissionsAsync.mockImplementation(
      () => new Promise((done) => {
        answer = () => {
          permissionActivityHop();
          permissionState = GRANTED;
          done(GRANTED);
        };
      }),
    );
    await mount('offline');

    let results: boolean[] = [];
    await act(async () => {
      const taps = Promise.all([flow.goOnline(), flow.goOnline()]);
      await vi.waitFor(() => expect(h.location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1));
      answer();
      results = await taps;
    });
    await settle();

    expect(results).toEqual([true, true]);
    expect(h.location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(flow.online).toBe(true);
  });

  it('Go online asks for the permission when it is missing, once', async () => {
    permissionState = MISSING;
    await mount('offline');
    expect(h.location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();

    let wentOnline = false;
    await act(async () => {
      wentOnline = await flow.goOnline();
    });
    await settle();

    expect(wentOnline).toBe(true);
    expect(flow.online).toBe(true);
    expect(h.location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(availabilityPosts()).toEqual(['idle']);
    expect(posts('/v1/rider/location')).toHaveLength(1);
    expect(h.location.watchPositionAsync).toHaveBeenCalledTimes(1);

    // The dialog's own pause and resume, and later returns, never ask again.
    await appState('background');
    await appState('active');
    await act(async () => {
      await flow.goOffline();
    });
    await act(async () => {
      await flow.goOnline();
    });
    await settle();
    expect(h.location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('keeps the rider offline when the permission is refused', async () => {
    permissionState = MISSING;
    requestAnswer = false;
    await mount('offline');

    let wentOnline = true;
    await act(async () => {
      wentOnline = await flow.goOnline();
    });
    await settle();

    expect(wentOnline).toBe(false);
    expect(flow.online).toBe(false);
    expect(flow.error).toBe(LOCATION_REQUIRED);
    expect(h.location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    // Dispatch is told the rider is available, then not, as before.
    expect(availabilityPosts()).toEqual(['idle', 'offline']);
    expect(posts('/v1/rider/location')).toHaveLength(0);
    expect(h.location.getCurrentPositionAsync).not.toHaveBeenCalled();
    expect(h.location.watchPositionAsync).not.toHaveBeenCalled();
  });

  it('keeps the rider offline without a dialog when Android will no longer ask', async () => {
    permissionState = BLOCKED;
    await mount('offline');

    let wentOnline = true;
    await act(async () => {
      wentOnline = await flow.goOnline();
    });
    await settle();

    expect(wentOnline).toBe(false);
    expect(flow.online).toBe(false);
    expect(flow.error).toBe(LOCATION_REQUIRED);
    expect(h.location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(availabilityPosts()).toEqual(['idle', 'offline']);
  });

  it('resumes foreground GPS reporting after returning to the app', async () => {
    await mount('idle');
    expect(posts('/v1/rider/location')).toHaveLength(1);
    const offerPolls = posts('/v1/rider/offers').length;

    // Past the five-second upload guard, short of the heartbeat.
    vi.advanceTimersByTime(6_000);
    await appState('background');
    await appState('active');

    expect(h.location.getCurrentPositionAsync).toHaveBeenCalledTimes(2);
    expect(posts('/v1/rider/location')).toHaveLength(2);
    expect(posts('/v1/rider/offers').length).toBeGreaterThan(offerPolls);
    expect(h.location.watchPositionAsync).toHaveBeenCalledTimes(1);
    expect(h.location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('starts the GPS watch on return once the rider has granted location in Settings', async () => {
    // Restored as online, but the permission was revoked while DASH was closed.
    permissionState = { granted: false, canAskAgain: true, status: 'denied' };
    await mount('idle');

    expect(flow.error).toBe(LOCATION_REQUIRED);
    expect(h.location.watchPositionAsync).not.toHaveBeenCalled();
    expect(h.location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();

    permissionState = GRANTED;
    await appState('active');

    expect(h.location.watchPositionAsync).toHaveBeenCalledTimes(1);
    expect(h.location.getCurrentPositionAsync).toHaveBeenCalledTimes(1);
    expect(posts('/v1/rider/location')).toHaveLength(1);
    expect(h.location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });
});

describe('rider GPS fixes after going online', () => {
  it('never lets an automatic fix or the watch open the location-accuracy dialog', async () => {
    await mount('idle');
    vi.advanceTimersByTime(6_000);
    await appState('background');
    await appState('active');

    // Restore and return-to-app fixes, and the continuous watch.
    expect(fixOptions()).toHaveLength(2);
    for (const options of fixOptions()) expect(options.mayShowUserSettingsDialog).toBe(false);
    const [watchOptions] = h.location.watchPositionAsync.mock.calls[0] as [{ mayShowUserSettingsDialog?: boolean }];
    expect(watchOptions.mayShowUserSettingsDialog).toBe(false);
  });

  it('leaves the dialog to Go online, which the rider chose', async () => {
    await mount('offline');
    await act(async () => {
      await flow.goOnline();
    });
    expect(fixOptions()).toHaveLength(1);
    expect(fixOptions()[0]?.mayShowUserSettingsDialog).toBeUndefined();
  });

  it('takes a heartbeat fix after 20 s without an upload, one at a time, and recovers from one that never answers', async () => {
    fakeAllTimers();
    await mount('idle');
    expect(h.location.getCurrentPositionAsync).toHaveBeenCalledTimes(1);

    // The next fix never answers.
    h.location.getCurrentPositionAsync.mockImplementation(() => new Promise(() => undefined));
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    await settle();
    expect(h.location.getCurrentPositionAsync).toHaveBeenCalledTimes(2);
    expect(fixOptions()[1]?.mayShowUserSettingsDialog).toBe(false);

    // Still searching: no second heartbeat fix on top of it.
    await act(async () => {
      vi.advanceTimersByTime(25_000);
    });
    await settle();
    expect(h.location.getCurrentPositionAsync).toHaveBeenCalledTimes(2);

    // At the 30 s limit the stuck fix is abandoned, and the next tick tries again.
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    await settle();
    expect(h.location.getCurrentPositionAsync).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    await settle();
    expect(h.location.getCurrentPositionAsync).toHaveBeenCalledTimes(3);
    expect(flow.online).toBe(true);
  });

  it('Go online gives up after 30 s without a GPS fix and tells dispatch the rider is offline', async () => {
    fakeAllTimers();
    h.location.getCurrentPositionAsync.mockImplementation(() => new Promise(() => undefined));
    await mount('offline');

    let result: boolean | undefined;
    await act(async () => {
      void flow.goOnline().then((ok) => {
        result = ok;
      });
    });
    await settle();
    expect(flow.busy).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await settle();

    expect(result).toBe(false);
    expect(flow.busy).toBe(false);
    expect(flow.online).toBe(false);
    expect(flow.error).toBe(NO_GPS_FIX);
    expect(availabilityPosts()).toEqual(['idle', 'offline']);
  });

  it('a GPS error during Go online does not leave dispatch thinking the rider is available', async () => {
    h.location.getCurrentPositionAsync.mockRejectedValue(new Error('Current location is unavailable'));
    await mount('offline');

    let wentOnline = true;
    await act(async () => {
      wentOnline = await flow.goOnline();
    });
    await settle();

    expect(wentOnline).toBe(false);
    expect(flow.online).toBe(false);
    expect(availabilityPosts()).toEqual(['idle', 'offline']);
  });
});
