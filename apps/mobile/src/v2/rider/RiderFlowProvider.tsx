import * as Location from 'expo-location';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';

import { api, ApiError } from '../../api';
import { useAppSession } from '../auth/AppSessionProvider';
import { createForegroundPermission } from './locationPermission';
import { riderTrace } from './riderTrace';

export interface Coordinate {
  latitude: number;
  longitude: number;
}

export interface RiderOffer {
  id: string;
  expiresAt: string;
  /** Straight-line metres from the rider's last reported position to the shop. */
  pickupDistanceMetres: number;
  /**
   * The dispatch engine's estimate of the ride to the shop: straight-line
   * distance times a detour factor over the vehicle's typical speed. An
   * estimate, and shown as one.
   */
  pickupEtaSeconds?: number | null;
  order: {
    code: string;
    pickup: { name: string; address: string; latitude: number; longitude: number };
    /** Coarsened by the server to three decimal places (~100 m). Not the customer's address. */
    dropoffArea: { latitude: number; longitude: number } | null;
    tripDistanceMetres: number;
    itemCount: number;
    /** When the shop expects the order to be ready, if it has said. */
    estimatedReadyAt?: string | null;
  };
}

export type DeliveryStatus =
  | 'rider_assigned'
  | 'rider_arrived'
  | 'picked_up'
  | 'en_route'
  | 'arrived'
  | 'delivered';

export interface RiderDelivery {
  id: string;
  code: string;
  status: DeliveryStatus;
  branch: { name: string; address: string; latitude: number; longitude: number; phone: string | null };
  address: {
    line1: string;
    landmark: string | null;
    instructions: string | null;
    contactPhone: string | null;
    latitude: number;
    longitude: number;
  };
  items: readonly { name: string; quantity: number }[];
  /**
   * The four digits the rider reads to the shop at the counter, which the
   * vendor types into the console's pickup check — the only thing tying the
   * person collecting to this order. The server sends it only while the order
   * is waiting for collection (rider assigned or arrived), and only to the
   * assigned rider.
   */
  pickupCode: string | null;
}

interface ApiRiderDelivery {
  id: string;
  code: string;
  status: DeliveryStatus;
  branch: RiderDelivery['branch'];
  address: RiderDelivery['address'] | null;
  items: readonly { nameSnapshot: string; quantity: number }[];
  /** Sent by GET /v1/rider/deliveries/:id only; the list omits it. */
  pickupCode?: string | null;
}

interface RiderFlowValue {
  online: boolean;
  busy: boolean;
  error: string | null;
  offer: RiderOffer | null;
  /** When this phone first saw the current offer, for the countdown ring's full width. */
  offerSeenAt: number | null;
  /** When dispatch was last asked for offers successfully. Real, so "checked 4s ago" is true. */
  offersCheckedAt: number | null;
  delivery: RiderDelivery | null;
  riderPosition: Coordinate | null;
  /** When the last GPS fix arrived on this phone. */
  positionUpdatedAt: number | null;
  /** That fix's reported accuracy radius, when the platform gives one. */
  positionAccuracyMetres: number | null;
  goOnline(): Promise<boolean>;
  goOffline(): Promise<boolean>;
  findOffers(): Promise<void>;
  respondToOffer(accept: boolean): Promise<string | null>;
  /** Drop an offer whose server deadline has passed, without waiting for the next poll. */
  expireOffer(offerId: string): void;
  progress(to: Exclude<DeliveryStatus, 'rider_assigned' | 'delivered'>): Promise<boolean>;
  complete(pin: string): Promise<boolean>;
  /** Put a finished delivery away so the workspace returns to searching. */
  clearCompletedDelivery(): void;
  clearError(): void;
}

/**
 * The message for a rider action attempted on a build with no API address.
 *
 * This used to be a preview mode: an invented offer, an invented delivery
 * address and a fixed handover PIN, all compiled into every build. The app's
 * front door now requires a signed-in session, which requires
 * an API, so no rider screen can mount on an unconnected build and the preview
 * could never run — it only shipped invented people and places inside the
 * bundle. A rider action without an API now refuses, plainly.
 */
const NOT_CONNECTED = 'This build has no DASH API address, so rider actions are unavailable.';

const LOCATION_REQUIRED = 'Location permission is required while a rider is online.';
const NO_GPS_FIX = 'DASH could not get a GPS fix. Move to open sky, check that Location is on, and try again.';

const RiderFlowContext = createContext<RiderFlowValue | null>(null);

const LOCATION_UPLOAD_INTERVAL_MS = 5_000;
/**
 * The longest an online rider goes without reporting a position. The watch
 * below only fires after 5 m of movement, so a rider parked and waiting for
 * work produced no fixes at all: their position went stale for dispatch after
 * two minutes, and the server's fifteen-minute online lease — renewed only by
 * position reports — then lapsed and signed them out of work. The API is
 * written for a live app reporting about every twenty seconds; this keeps it
 * one.
 */
const LOCATION_HEARTBEAT_MS = 20_000;
/**
 * The longest any one-shot GPS fix is waited for. expo-location's
 * getCurrentPositionAsync has no timeout of its own, so a fix that never comes
 * left Go online on "Going online…" indefinitely (seen on the A55), and left
 * the heartbeat's in-flight flag set so it never fired again.
 */
const FRESH_FIX_TIMEOUT_MS = 30_000;
/**
 * Options for every fix DASH takes on its own: the heartbeat, the watch, and
 * the fresh fix on restore and on return to the app. With the network
 * location provider off, expo-location otherwise opens Google's "location
 * accuracy" dialog. That is another activity on top of DASH, and its pause and
 * resume would retrigger the return-to-app fix, the same loop the permission
 * request caused. GPS alone still answers. Only Go online, which the rider
 * chose, may show the dialog.
 */
const AUTOMATIC_FIX: Location.LocationOptions = { accuracy: Location.Accuracy.High, mayShowUserSettingsDialog: false };

class FixTimeout extends Error {}

function withFixTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new FixTimeout('GPS fix timed out')), FRESH_FIX_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (caught: unknown) => {
        clearTimeout(timer);
        reject(caught);
      },
    );
  });
}

const errorName = (caught: unknown): string =>
  caught instanceof Error ? `${caught.name}: ${caught.message}`.slice(0, 160) : String(caught).slice(0, 160);

export function RiderFlowProvider({ children }: { children: ReactNode }) {
  const auth = useAppSession();
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offer, setOffer] = useState<RiderOffer | null>(null);
  const [delivery, setDelivery] = useState<RiderDelivery | null>(null);
  const [riderPosition, setRiderPosition] = useState<Coordinate | null>(null);
  const [positionUpdatedAt, setPositionUpdatedAt] = useState<number | null>(null);
  const [positionAccuracyMetres, setPositionAccuracyMetres] = useState<number | null>(null);
  const [offersCheckedAt, setOffersCheckedAt] = useState<number | null>(null);
  const [offerSeenAt, setOfferSeenAt] = useState<number | null>(null);
  const seenOfferId = useRef<string | null>(null);
  const lastLocationUploadAt = useRef(0);
  const locationUploadInFlight = useRef(false);
  // One permission reader for the whole rider flow, so overlapping lifecycle
  // events share a single check and Go online a single request.
  const [permission] = useState(() => createForegroundPermission(Location));
  const freshFix = useRef<Promise<boolean> | null>(null);
  const watchState = useRef<'idle' | 'starting' | 'running'>('idle');
  const [watchAttempt, setWatchAttempt] = useState(0);
  const deliveryRevision = useRef(0);
  const deliveryReadGeneration = useRef(0);
  const busyNow = useRef(busy);
  busyNow.current = busy;

  const fail = useCallback((caught: unknown) => {
    setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.');
  }, []);

  const publishPosition = useCallback(async (position: Location.LocationObject): Promise<void> => {
    const point = { latitude: position.coords.latitude, longitude: position.coords.longitude };
    // Keep the marker responsive to every GPS fix, but bound network writes.
    // Some Android providers can emit a burst of fixes even when timeInterval
    // is configured. Without an application-level guard those bursts can flood
    // /v1/rider/location and trip the server rate limit.
    setRiderPosition(point);
    setPositionUpdatedAt(Date.now());
    setPositionAccuracyMetres(
      typeof position.coords.accuracy === 'number' && Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
    );
    if (!api.configured) return;

    const now = Date.now();
    if (locationUploadInFlight.current) return;
    if (now - lastLocationUploadAt.current < LOCATION_UPLOAD_INTERVAL_MS) return;

    locationUploadInFlight.current = true;
    lastLocationUploadAt.current = now;
    try {
      await api.request('/v1/rider/location', {
        method: 'POST',
        body: {
          ...point,
          accuracy: position.coords.accuracy ?? undefined,
          heading: position.coords.heading ?? undefined,
          speed: position.coords.speed ?? undefined,
          recordedAt: new Date(position.timestamp).toISOString(),
        },
      });
    } finally {
      locationUploadInFlight.current = false;
    }
  }, []);

  /**
   * Take one fresh fix and report it. Only Go online may ask for the
   * permission (`mayAsk`). Restoring a working rider and returning to the app
   * read it silently: asking there opened Android's permission activity on
   * every resume, and that activity's own pause and resume triggered the next
   * request (see locationPermission.ts). Silent reports share one in-flight fix.
   */
  const reportCurrentPosition = useCallback((mayAsk: boolean): Promise<boolean> => {
    if (!mayAsk && freshFix.current) return freshFix.current;
    const run = (async () => {
      const startedAt = Date.now();
      const granted = await (mayAsk ? permission.ensure() : permission.check());
      riderTrace('permission', { mode: mayAsk ? 'ensure' : 'check', granted, ms: Date.now() - startedAt });
      if (!granted) {
        setError(LOCATION_REQUIRED);
        return false;
      }
      let position: Location.LocationObject;
      try {
        position = await withFixTimeout(
          Location.getCurrentPositionAsync(mayAsk ? { accuracy: Location.Accuracy.High } : AUTOMATIC_FIX),
        );
      } catch (caught) {
        riderTrace('fix.failed', { mode: mayAsk ? 'online' : 'silent', error: errorName(caught), ms: Date.now() - startedAt });
        if (!(caught instanceof FixTimeout)) throw caught;
        // Going online needs a position; say why it failed rather than spin.
        // A silent report just leaves the GPS chip to show the age.
        if (mayAsk) setError(NO_GPS_FIX);
        return false;
      }
      riderTrace('fix', { mode: mayAsk ? 'online' : 'silent', accuracy: position.coords.accuracy ?? null, ms: Date.now() - startedAt });
      await publishPosition(position);
      return true;
    })();
    if (!mayAsk) {
      freshFix.current = run;
      run
        .finally(() => {
          if (freshFix.current === run) freshFix.current = null;
        })
        .catch(() => undefined);
    }
    return run;
  }, [permission, publishPosition]);

  const findOffers = useCallback(async () => {
    if (!api.configured || !online) return;
    try {
      const response = await api.request<{ offers: RiderOffer[] }>('/v1/rider/offers');
      const next = response.offers[0] ?? null;
      if (next && next.id !== seenOfferId.current) setOfferSeenAt(Date.now());
      seenOfferId.current = next?.id ?? null;
      setOffer(next);
      setOffersCheckedAt(Date.now());
    } catch (caught) {
      fail(caught);
    }
  }, [fail, online]);

  useEffect(() => {
    if (!online || !api.configured) return;
    void findOffers();
    const timer = setInterval(() => void findOffers(), 8_000);
    return () => clearInterval(timer);
  }, [findOffers, online]);

  useEffect(() => {
    if (!online || !api.configured) return;

    let subscription: Location.LocationSubscription | null = null;
    let cancelled = false;
    watchState.current = 'starting';
    riderTrace('watch.start', { attempt: watchAttempt });

    void (async () => {
      // Read, never request: Go online has already asked, and a request here
      // would open the permission activity every time the watch starts.
      if (!(await permission.check())) {
        if (!cancelled) {
          watchState.current = 'idle';
          setError(LOCATION_REQUIRED);
        }
        return;
      }

      const next = await Location.watchPositionAsync(
        {
          ...AUTOMATIC_FIX,
          timeInterval: 5_000,
          distanceInterval: 5,
        },
        (position) => {
          void publishPosition(position).catch(fail);
        },
      );

      if (cancelled) next.remove();
      else {
        subscription = next;
        watchState.current = 'running';
        riderTrace('watch.running');
      }
    })().catch((caught) => {
      riderTrace('watch.failed', { error: errorName(caught) });
      if (!cancelled) watchState.current = 'idle';
      fail(caught);
    });

    return () => {
      cancelled = true;
      watchState.current = 'idle';
      riderTrace('watch.stop', { hadSubscription: subscription !== null });
      subscription?.remove();
    };
  }, [fail, online, permission, publishPosition, watchAttempt]);

  useEffect(() => {
    if (!online || !api.configured) return;
    // A high-accuracy fix indoors can take longer than the tick; never ask
    // for a second while the first is still searching.
    let fixPending = false;
    const timer = setInterval(() => {
      // Not while another one-shot fix (Go online, restore, return to the app)
      // is still searching: that one will upload, and two would only compete.
      if (fixPending || freshFix.current || Date.now() - lastLocationUploadAt.current < LOCATION_HEARTBEAT_MS) return;
      fixPending = true;
      const startedAt = Date.now();
      riderTrace('heartbeat.fix', { sinceUploadMs: startedAt - lastLocationUploadAt.current });
      // A real fix, uploaded through the same path as the watch. A phone that
      // cannot get one (indoors, location off) simply reports nothing and the
      // GPS chip shows the position going stale; a server refusal — an
      // expired lease, say — is shown like any other. The timeout keeps one
      // fix that never answers from stopping the heartbeat for good.
      void withFixTimeout(Location.getCurrentPositionAsync(AUTOMATIC_FIX))
        .then(
          (position) => {
            riderTrace('heartbeat.fixed', { accuracy: position.coords.accuracy ?? null, ms: Date.now() - startedAt });
            return publishPosition(position).catch(fail);
          },
          (caught: unknown) => riderTrace('heartbeat.failed', { error: errorName(caught), ms: Date.now() - startedAt }),
        )
        .finally(() => {
          fixPending = false;
        });
    }, 5_000);
    return () => clearInterval(timer);
  }, [fail, online, publishPosition]);

  const restoreDelivery = useCallback(async (current: () => boolean = () => true) => {
    if (!api.configured) return;
    const read = ++deliveryReadGeneration.current;
    const revision = deliveryRevision.current;
    const valid = () => current() && (Platform.OS !== 'ios'
      || (read === deliveryReadGeneration.current && revision === deliveryRevision.current));
    try {
      const response = await api.request<{ deliveries: ApiRiderDelivery[] }>('/v1/rider/deliveries');
      if (!valid()) return;
      const active = response.deliveries[0];
      if (!active) {
        setDelivery(null);
        return;
      }
      // The list leaves out the pickup code, so a delivery restored after a
      // relaunch is read in full — otherwise the rider would arrive at the shop
      // with no code to give.
      const detail = await api.request<{ delivery: ApiRiderDelivery }>(`/v1/rider/deliveries/${encodeURIComponent(active.id)}`);
      if (valid()) setDelivery(normaliseDelivery(detail.delivery));
    } catch (caught) {
      if (valid()) throw caught;
    }
  }, []);

  useEffect(() => {
    if (!api.configured) return;
    if (auth.state !== 'authenticated') {
      deliveryRevision.current += 1;
      setOnline(false);
      setOffer(null);
      setDelivery(null);
      return;
    }
    const availability = auth.viewer?.riderAvailability;
    const working = availability === 'idle' || availability === 'on_break' || availability === 'on_delivery';
    setOnline(working);
    if (working) {
      // A rider reopening DASH must immediately become fresh for dispatch.
      // The server may still remember them as idle/on_delivery while their
      // online lease has expired because the app was closed. Publishing one
      // real GPS fix renews that lease and makes them discoverable again
      // without forcing them to toggle Offline -> Online.
      void reportCurrentPosition(false).catch(fail);
      void restoreDelivery().catch(fail);
    }
  }, [auth.state, auth.viewer?.riderAvailability, fail, reportCurrentPosition, restoreDelivery]);

  useEffect(() => () => { deliveryRevision.current += 1; }, []);

  useEffect(() => {
    if (!api.configured || !online || auth.state !== 'authenticated') return;
    let disposed = false;
    let backgrounded = AppState.currentState === 'background';
    const subscription = AppState.addEventListener('change', (nextState) => {
      riderTrace('appstate', { state: nextState, watch: watchState.current });
      if (nextState === 'background') backgrounded = true;
      if (nextState === 'active') {
        if (Platform.OS === 'ios' && backgrounded && !busyNow.current) {
          // iOS suspends JS while hidden. The server may cancel/reassign or
          // advance the delivery meanwhile; GPS/offer refresh cannot recover it.
          void restoreDelivery(() => !disposed).catch(fail);
        }
        backgrounded = false;
        // Android may suspend foreground GPS while DASH is backgrounded. As
        // soon as the rider returns, push a fresh fix immediately rather than
        // waiting for the next watchPosition callback — and ask dispatch at
        // once, so an offer made while the app was hidden is not left to the
        // next eight-second poll. The permission is only read here, never
        // requested. expo-location resumes a running watch by itself; a watch
        // that could not start (no permission at the time) is tried again.
        void reportCurrentPosition(false).catch(fail);
        if (watchState.current === 'idle') setWatchAttempt((attempt) => attempt + 1);
        void findOffers();
      }
    });
    return () => { disposed = true; subscription.remove(); };
  }, [auth.state, fail, findOffers, online, reportCurrentPosition, restoreDelivery]);

  const goOnline = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const startedAt = Date.now();
    riderTrace('online.start');
    let markedAvailable = false;
    const markOffline = () =>
      api.request('/v1/rider/availability', { method: 'POST', body: { availability: 'offline' } }).catch(() => undefined);
    try {
      if (!api.configured) {
        setError(NOT_CONNECTED);
        return false;
      }
      await api.request('/v1/rider/availability', { method: 'POST', body: { availability: 'idle' } });
      markedAvailable = true;
      // Going online starts a new server lease. Do not let a very recent fix
      // from the previous online session suppress the first fresh report.
      lastLocationUploadAt.current = 0;
      if (!(await reportCurrentPosition(true))) {
        await markOffline();
        riderTrace('online.done', { ok: false, ms: Date.now() - startedAt });
        return false;
      }
      await restoreDelivery();
      setOnline(true);
      riderTrace('online.done', { ok: true, ms: Date.now() - startedAt });
      return true;
    } catch (caught) {
      riderTrace('online.failed', { error: errorName(caught), ms: Date.now() - startedAt });
      // Dispatch must not keep a rider available that the app shows as offline.
      if (markedAvailable) await markOffline();
      fail(caught);
      return false;
    } finally {
      setBusy(false);
    }
  }, [fail, reportCurrentPosition, restoreDelivery]);

  const goOffline = useCallback(async (): Promise<boolean> => {
    deliveryRevision.current += 1;
    setBusy(true);
    setError(null);
    try {
      if (api.configured) {
        await api.request('/v1/rider/availability', { method: 'POST', body: { availability: 'offline' } });
      }
      setOnline(false);
      setOffer(null);
      lastLocationUploadAt.current = 0;
      return true;
    } catch (caught) {
      fail(caught);
      return false;
    } finally {
      setBusy(false);
    }
  }, [fail]);

  const respondToOffer = useCallback(async (accept: boolean): Promise<string | null> => {
    if (!offer) return null;
    deliveryRevision.current += 1;
    setBusy(true);
    setError(null);
    try {
      if (!api.configured) {
        setError(NOT_CONNECTED);
        return null;
      }
      const response = await api.request<{ accepted: boolean; orderId?: string }>(`/v1/rider/offers/${encodeURIComponent(offer.id)}/respond`, {
        method: 'POST',
        body: { accept },
      });
      setOffer(null);
      if (!response.accepted || !response.orderId) return null;
      const detail = await api.request<{ delivery: ApiRiderDelivery }>(`/v1/rider/deliveries/${encodeURIComponent(response.orderId)}`);
      const next = normaliseDelivery(detail.delivery);
      setDelivery(next);
      return next.id;
    } catch (caught) {
      fail(caught);
      return null;
    } finally {
      setBusy(false);
    }
  }, [fail, offer]);

  const progress = useCallback(async (to: Exclude<DeliveryStatus, 'rider_assigned' | 'delivered'>): Promise<boolean> => {
    if (!delivery) return false;
    deliveryRevision.current += 1;
    setBusy(true);
    setError(null);
    try {
      if (!api.configured) {
        setError(NOT_CONNECTED);
        return false;
      }
      await api.request(`/v1/rider/deliveries/${encodeURIComponent(delivery.id)}/progress`, { method: 'POST', body: { to } });
      setDelivery((current) => current ? { ...current, status: to } : current);
      return true;
    } catch (caught) {
      fail(caught);
      return false;
    } finally {
      setBusy(false);
    }
  }, [delivery, fail]);

  const complete = useCallback(async (pin: string): Promise<boolean> => {
    if (!delivery) return false;
    deliveryRevision.current += 1;
    setBusy(true);
    setError(null);
    try {
      if (!api.configured) {
        setError(NOT_CONNECTED);
        return false;
      }
      await api.request(`/v1/rider/deliveries/${encodeURIComponent(delivery.id)}/complete`, {
        method: 'POST',
        body: {
          pin,
          ...(riderPosition
            ? { latitude: riderPosition.latitude, longitude: riderPosition.longitude }
            : {}),
        },
      });
      setDelivery((current) => current ? { ...current, status: 'delivered' } : current);
      setOnline(true);
      return true;
    } catch (caught) {
      fail(caught);
      return false;
    } finally {
      setBusy(false);
    }
  }, [delivery, fail, riderPosition]);

  const value = useMemo<RiderFlowValue>(() => ({
    online,
    busy,
    error,
    offer,
    delivery,
    riderPosition,
    goOnline,
    goOffline,
    findOffers,
    respondToOffer,
    expireOffer: (offerId: string) => setOffer((current) => (current?.id === offerId ? null : current)),
    progress,
    complete,
    clearCompletedDelivery: () => {
      deliveryRevision.current += 1;
      setDelivery((current) => (current?.status === 'delivered' ? null : current));
    },
    clearError: () => setError(null),
    offerSeenAt,
    offersCheckedAt,
    positionUpdatedAt,
    positionAccuracyMetres,
  }), [busy, complete, delivery, error, findOffers, goOffline, goOnline, offer, offerSeenAt, offersCheckedAt, online, positionAccuracyMetres, positionUpdatedAt, progress, respondToOffer, riderPosition]);

  return <RiderFlowContext.Provider value={value}>{children}</RiderFlowContext.Provider>;
}

export function useRiderFlow(): RiderFlowValue {
  const value = useContext(RiderFlowContext);
  if (!value) throw new Error('useRiderFlow must be used inside <RiderFlowProvider>.');
  return value;
}

function normaliseDelivery(delivery: ApiRiderDelivery): RiderDelivery {
  if (!delivery.address) throw new Error('This delivery has no drop-off address.');
  return {
    id: delivery.id,
    code: delivery.code,
    status: delivery.status,
    branch: delivery.branch,
    address: delivery.address,
    items: delivery.items.map((item) => ({ name: item.nameSnapshot, quantity: item.quantity })),
    pickupCode: typeof delivery.pickupCode === 'string' && /^\d{4}$/.test(delivery.pickupCode) ? delivery.pickupCode : null,
  };
}
