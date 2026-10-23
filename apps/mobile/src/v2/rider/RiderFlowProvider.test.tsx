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
    os: 'android',
    appState: 'active',
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
    h.appState = next;
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
  h.os = 'android';
  h.appState = 'active';
  h.session.state = 'authenticated';
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

describe('iOS active delivery recovery after suspension', () => {
  it('distinguishes initial assignment restoration from a confirmed empty workload', async () => {
    h.os = 'ios';
    let finish!: (value: unknown) => void;
    h.request.mockImplementation(async (url: string) => {
      if (url === '/v1/rider/offers') return { offers: [] };
      if (url === '/v1/rider/deliveries') return new Promise((resolve) => { finish = resolve; });
      return {};
    });
    await mount('on_delivery');
    expect(flow.delivery).toBeNull();
    expect(flow.deliveryRestored).toBe(false);
    await act(async () => finish({ deliveries: [] }));
    await settle();
    expect(flow.delivery).toBeNull();
    expect(flow.deliveryRestored).toBe(true);
  });

  it('keeps delivery readiness after completion/clear so Customer notifications are not blocked forever', async () => {
    await mount('on_delivery');
    expect(flow.deliveryRestored).toBe(true);
    await act(async () => { await flow.complete('1234'); });
    await act(async () => flow.clearCompletedDelivery());
    expect(flow.delivery).toBeNull();
    expect(flow.deliveryRestored).toBe(true);
  });

  it('does not claim assignment restoration when the server read fails', async () => {
    h.request.mockImplementation(async (url: string) => {
      if (url === '/v1/rider/offers') return { offers: [] };
      if (url === '/v1/rider/deliveries') throw new Error('Offline');
      return {};
    });
    await mount('on_delivery');
    expect(flow.deliveryRestored).toBe(false);
    expect(flow.delivery).toBeNull();
  });
  const delivery = (status = 'rider_assigned') => ({
    id: 'test-delivery', code: 'TEST-1', status,
    branch: { name: 'Test shop', address: 'Test pickup', latitude: 6.2, longitude: 6.7, phone: null },
    address: { line1: 'Test dropoff', landmark: null, instructions: null, contactPhone: null, latitude: 6.3, longitude: 6.8 },
    items: [], pickupCode: '1234',
  });
  let remote = delivery();
  beforeEach(() => {
    h.os = 'ios';
    remote = delivery();
    h.request.mockImplementation(async (url: string) => {
      if (url === '/v1/rider/offers') return { offers: [] };
      if (url === '/v1/rider/deliveries') return { deliveries: [remote] };
      if (url === '/v1/rider/deliveries/test-delivery') return { delivery: remote };
      return {};
    });
  });

  it('reloads the server delivery and pickup code after background/active', async () => {
    await mount('on_delivery');
    expect(flow.delivery?.status).toBe('rider_assigned');
    await appState('background');
    remote = delivery('en_route');
    await appState('active');
    expect(flow.delivery?.status).toBe('en_route');
    expect(flow.delivery?.pickupCode).toBe('1234');
    expect(posts('/v1/rider/deliveries')).toHaveLength(2);
    expect(h.location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('gives a job back with the chosen reason and returns to searching', async () => {
    await mount('on_delivery');
    expect(flow.delivery?.id).toBe('test-delivery');

    let released = false;
    await act(async () => {
      released = await flow.release('vehicle_problem');
    });
    expect(released).toBe(true);
    const [, options] = posts('/v1/rider/deliveries/test-delivery/release')[0]!;
    expect((options as { body: unknown }).body).toEqual({ reasonCode: 'vehicle_problem' });
    expect(flow.delivery).toBeNull();
  });

  it('keeps the job and shows why when the server refuses to release it', async () => {
    await mount('on_delivery');
    h.request.mockImplementation(async (url: string) => {
      if (url.endsWith('/release')) {
        // The mocked ApiError above takes just a message.
        const { ApiError } = await import('../../api');
        throw new (ApiError as unknown as new (message: string) => Error)('You already have this order.');
      }
      if (url === '/v1/rider/offers') return { offers: [] };
      if (url === '/v1/rider/deliveries') return { deliveries: [remote] };
      return { delivery: remote };
    });
    let released = true;
    await act(async () => {
      released = await flow.release('emergency');
    });
    expect(released).toBe(false);
    expect(flow.delivery?.id).toBe('test-delivery');
    expect(flow.error).toBe('You already have this order.');
  });

  it('clears a delivery no longer assigned on the server', async () => {
    await mount('on_delivery');
    h.request.mockImplementation(async (url: string) => {
      if (url === '/v1/rider/offers') return { offers: [] };
      if (url === '/v1/rider/deliveries') return { deliveries: [] };
      return {};
    });
    await appState('background');
    await appState('active');
    expect(flow.delivery).toBeNull();
  });

  it('ignores permission-dialog transitions and duplicate active events', async () => {
    await mount('on_delivery');
    await appState('inactive');
    await appState('active');
    await appState('active');
    expect(posts('/v1/rider/deliveries')).toHaveLength(1);
  });

  it('does not add delivery reloads to Android resume', async () => {
    h.os = 'android';
    await mount('on_delivery');
    await appState('background');
    await appState('active');
    expect(posts('/v1/rider/deliveries')).toHaveLength(1);
  });

  it('discards a resume detail response after sign-out', async () => {
    await mount('on_delivery');
    let finish!: (value: unknown) => void;
    h.request.mockImplementation(async (url: string) => {
      if (url === '/v1/rider/offers') return { offers: [] };
      if (url === '/v1/rider/deliveries') return { deliveries: [remote] };
      if (url === '/v1/rider/deliveries/test-delivery') return new Promise((resolve) => { finish = resolve; });
      return {};
    });
    await appState('background');
    await appState('active');
    expect(finish).toBeTypeOf('function');
    h.session.state = 'unauthenticated';
    await act(async () => root!.render(<RiderFlowProvider><Probe /></RiderFlowProvider>));
    await settle();
    await act(async () => finish({ delivery: delivery('en_route') }));
    await settle();
    expect(flow.delivery).toBeNull();
    expect(flow.online).toBe(false);
  });

  it('does not roll back progress with an older resume response', async () => {
    await mount('on_delivery');
    let finish!: (value: unknown) => void;
    h.request.mockImplementation(async (url: string) => {
      if (url === '/v1/rider/offers') return { offers: [] };
      if (url === '/v1/rider/deliveries') return { deliveries: [remote] };
      if (url === '/v1/rider/deliveries/test-delivery') return new Promise((resolve) => { finish = resolve; });
      return {};
    });
    await appState('background');
    await appState('active');
    expect(finish).toBeTypeOf('function');
    await act(async () => { await flow.progress('rider_arrived'); });
    await act(async () => finish({ delivery: delivery('rider_assigned') }));
    await settle();
    expect(flow.delivery?.status).toBe('rider_arrived');
  });

  it('drops an older resume when a newer resume returns no assignment', async () => {
    await mount('on_delivery');
    let finish!: (value: unknown) => void;
    let lists = 0;
    h.request.mockImplementation(async (url: string) => {
      if (url === '/v1/rider/offers') return { offers: [] };
      if (url === '/v1/rider/deliveries') return { deliveries: ++lists === 1 ? [remote] : [] };
      if (url === '/v1/rider/deliveries/test-delivery') return new Promise((resolve) => { finish = resolve; });
      return {};
    });
    await appState('background'); await appState('active');
    expect(finish).toBeTypeOf('function');
    await appState('background'); await appState('active');
    await act(async () => finish({ delivery: remote }));
    await settle();
    expect(flow.delivery).toBeNull();
  });

  it('does not let a delayed initial restore replace a newer resume result', async () => {
    let finish!: (value: unknown) => void;
    let lists = 0;
    h.request.mockImplementation(async (url: string) => {
      if (url === '/v1/rider/offers') return { offers: [] };
      if (url === '/v1/rider/deliveries') {
        if (++lists === 1) return new Promise((resolve) => { finish = resolve; });
        return { deliveries: [] };
      }
      if (url === '/v1/rider/deliveries/test-delivery') return { delivery: remote };
      return {};
    });
    await mount('on_delivery');
    await appState('background'); await appState('active');
    await act(async () => finish({ deliveries: [remote] }));
    await settle();
    expect(flow.delivery).toBeNull();
    expect(posts('/v1/rider/deliveries/test-delivery')).toHaveLength(0);
  });

  it.each(['ios', 'android'])('%s: reconciles a resume deferred by a failed progress request only on iOS', async (os) => {
    h.os = os;
    await mount('on_delivery');
    let rejectProgress!: (error: Error) => void;
    h.request.mockImplementation(async (url: string) => {
      if (url.endsWith('/progress')) return new Promise((_resolve, reject) => { rejectProgress = reject; });
      if (url === '/v1/rider/offers') return { offers: [] };
      if (url === '/v1/rider/deliveries') return { deliveries: [] };
      return {};
    });
    let action!: Promise<boolean>;
    await act(async () => { action = flow.progress('rider_arrived'); });
    expect(flow.busy).toBe(true);
    await appState('background'); await appState('active');
    expect(posts('/v1/rider/deliveries')).toHaveLength(1);
    await act(async () => { rejectProgress(new Error('Connection lost')); await action; });
    await settle();
    expect(flow.busy).toBe(false);
    expect(posts('/v1/rider/deliveries')).toHaveLength(os === 'ios' ? 2 : 1);
    if (os === 'ios') expect(flow.delivery).toBeNull();
    else expect(flow.delivery?.status).toBe('rider_assigned');
    expect(h.location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('coalesces busy iOS resumes and waits for the successful action before reading server state', async () => {
    await mount('on_delivery');
    let finishProgress!: (value: unknown) => void;
    h.request.mockImplementation(async (url: string) => {
      if (url.endsWith('/progress')) return new Promise((resolve) => { finishProgress = resolve; });
      if (url === '/v1/rider/offers') return { offers: [] };
      if (url === '/v1/rider/deliveries') return { deliveries: [remote] };
      if (url === '/v1/rider/deliveries/test-delivery') return { delivery: remote };
      return {};
    });
    let action!: Promise<boolean>;
    await act(async () => { action = flow.progress('rider_arrived'); });
    await appState('background'); await appState('active');
    await appState('background'); await appState('active');
    expect(posts('/v1/rider/deliveries')).toHaveLength(1);
    remote = delivery('en_route');
    await act(async () => { finishProgress({}); await action; });
    await settle();
    expect(flow.delivery?.status).toBe('en_route');
    expect(posts('/v1/rider/deliveries')).toHaveLength(2);
    await appState('active');
    expect(posts('/v1/rider/deliveries')).toHaveLength(2);
  });

  it.each(['background', 'inactive', 'sign-out', 'unmount'])('does not drain a deferred resume after %s', async (boundary) => {
    await mount('on_delivery');
    let finishProgress!: (value: unknown) => void;
    h.request.mockImplementation(async (url: string) => {
      if (url.endsWith('/progress')) return new Promise((resolve) => { finishProgress = resolve; });
      if (url === '/v1/rider/offers') return { offers: [] };
      if (url === '/v1/rider/deliveries') return { deliveries: [] };
      return {};
    });
    let action!: Promise<boolean>;
    await act(async () => { action = flow.progress('rider_arrived'); });
    await appState('background'); await appState('active');
    if (boundary === 'background' || boundary === 'inactive') await appState(boundary);
    if (boundary === 'sign-out') {
      h.session.state = 'unauthenticated';
      await act(async () => root!.render(<RiderFlowProvider><Probe /></RiderFlowProvider>));
    }
    if (boundary === 'unmount') {
      await act(async () => root!.unmount()); root = null;
    }
    await act(async () => { finishProgress({}); await action; });
    await settle();
    expect(posts('/v1/rider/deliveries')).toHaveLength(1);
    if (boundary === 'background' || boundary === 'inactive') {
      await appState('active');
      expect(posts('/v1/rider/deliveries')).toHaveLength(2);
      expect(flow.delivery).toBeNull();
    }
  });

  it('does not add a refresh after an ordinary foreground action without a resume', async () => {
    await mount('on_delivery');
    await act(async () => { await flow.progress('rider_arrived'); });
    await settle();
    expect(flow.delivery?.status).toBe('rider_arrived');
    expect(posts('/v1/rider/deliveries')).toHaveLength(1);
  });

  it('retains the delivery on deferred refresh failure without a retry loop', async () => {
    await mount('on_delivery');
    let finishProgress!: (value: unknown) => void;
    h.request.mockImplementation(async (url: string) => {
      if (url.endsWith('/progress')) return new Promise((resolve) => { finishProgress = resolve; });
      if (url === '/v1/rider/offers') return { offers: [] };
      if (url === '/v1/rider/deliveries') throw new Error('Offline');
      return {};
    });
    let action!: Promise<boolean>;
    await act(async () => { action = flow.progress('rider_arrived'); });
    await appState('background'); await appState('active');
    await act(async () => { finishProgress({}); await action; });
    await settle(); await settle();
    expect(flow.delivery?.status).toBe('rider_arrived');
    expect(flow.error).toBeTruthy();
    expect(posts('/v1/rider/deliveries')).toHaveLength(2);
    await appState('active');
    expect(posts('/v1/rider/deliveries')).toHaveLength(2);
  });

  it('does not roll back a newer action with an old deferred detail response', async () => {
    await mount('on_delivery');
    let finishProgress!: (value: unknown) => void;
    let finishDetail!: (value: unknown) => void;
    let progressCalls = 0;
    h.request.mockImplementation(async (url: string) => {
      if (url.endsWith('/progress') && ++progressCalls === 1) return new Promise((resolve) => { finishProgress = resolve; });
      if (url === '/v1/rider/offers') return { offers: [] };
      if (url === '/v1/rider/deliveries') return { deliveries: [remote] };
      if (url === '/v1/rider/deliveries/test-delivery') return new Promise((resolve) => { finishDetail = resolve; });
      return {};
    });
    let action!: Promise<boolean>;
    await act(async () => { action = flow.progress('rider_arrived'); });
    await appState('background'); await appState('active');
    await act(async () => { finishProgress({}); await action; });
    await settle();
    const oldDetail = finishDetail;
    expect(oldDetail).toBeTypeOf('function');
    await act(async () => { await flow.progress('picked_up'); });
    await act(async () => oldDetail({ delivery: delivery('rider_assigned') }));
    await settle();
    expect(flow.delivery?.status).toBe('picked_up');
    // Settle the replacement read after the newer action as well.
    await act(async () => finishDetail({ delivery: delivery('picked_up') }));
    await settle();
    expect(flow.delivery?.status).toBe('picked_up');
  });

  it('keeps the last delivery on network failure and retries next resume', async () => {
    await mount('on_delivery');
    h.request.mockRejectedValueOnce(new Error('Offline'));
    await appState('background'); await appState('active');
    expect(flow.delivery?.status).toBe('rider_assigned');
    remote = delivery('en_route');
    await appState('background'); await appState('active');
    expect(flow.delivery?.status).toBe('en_route');
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

  it('goes online on iOS when Core Location reports unknown course and speed as -1', async () => {
    h.os = 'ios';
    h.location.getCurrentPositionAsync.mockImplementation(async () => ({
      // What a stationary iPhone returns: no course or speed yet, as -1, not null.
      coords: { latitude: 6.2059, longitude: 6.6959, accuracy: 35, altitude: 40, altitudeAccuracy: 12, heading: -1, speed: -1 },
      timestamp: Date.now(),
    }));
    await mount('offline');

    let wentOnline = false;
    await act(async () => {
      wentOnline = await flow.goOnline();
    });
    await settle();

    expect(wentOnline).toBe(true);
    const [, options] = posts('/v1/rider/location')[0]!;
    const body = (options as { body: Record<string, unknown> }).body;
    expect(body).toMatchObject({ latitude: 6.2059, longitude: 6.6959, accuracy: 35 });
    expect(body).not.toHaveProperty('heading');
    expect(body).not.toHaveProperty('speed');
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
