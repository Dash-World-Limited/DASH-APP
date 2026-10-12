import * as Location from 'expo-location';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { api, ApiError } from '../../api';
import { useAppSession } from '../auth/AppSessionProvider';

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

  const reportCurrentPosition = useCallback(async (): Promise<boolean> => {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) {
      setError('Location permission is required while a rider is online.');
      return false;
    }
    const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    await publishPosition(position);
    return true;
  }, [publishPosition]);

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

    void (async () => {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        setError('Location permission is required while a rider is online.');
        return;
      }

      const next = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          timeInterval: 5_000,
          distanceInterval: 5,
        },
        (position) => {
          void publishPosition(position).catch(fail);
        },
      );

      if (cancelled) next.remove();
      else subscription = next;
    })().catch(fail);

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [fail, online, publishPosition]);

  useEffect(() => {
    if (!online || !api.configured) return;
    // A high-accuracy fix indoors can take longer than the tick; never ask
    // for a second while the first is still searching.
    let fixPending = false;
    const timer = setInterval(() => {
      if (fixPending || Date.now() - lastLocationUploadAt.current < LOCATION_HEARTBEAT_MS) return;
      fixPending = true;
      // A real fix, uploaded through the same path as the watch. A phone that
      // cannot get one (indoors, location off) simply reports nothing and the
      // GPS chip shows the position going stale; a server refusal — an
      // expired lease, say — is shown like any other.
      void Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })
        .then(
          (position) => publishPosition(position).catch(fail),
          () => undefined,
        )
        .finally(() => {
          fixPending = false;
        });
    }, 5_000);
    return () => clearInterval(timer);
  }, [fail, online, publishPosition]);

  const restoreDelivery = useCallback(async () => {
    if (!api.configured) return;
    const response = await api.request<{ deliveries: ApiRiderDelivery[] }>('/v1/rider/deliveries');
    const active = response.deliveries[0];
    if (!active) {
      setDelivery(null);
      return;
    }
    // The list leaves out the pickup code, so a delivery restored after a
    // relaunch is read in full — otherwise the rider would arrive at the shop
    // with no code to give.
    const detail = await api.request<{ delivery: ApiRiderDelivery }>(`/v1/rider/deliveries/${encodeURIComponent(active.id)}`);
    setDelivery(normaliseDelivery(detail.delivery));
  }, []);

  useEffect(() => {
    if (!api.configured) return;
    if (auth.state !== 'authenticated') {
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
      void reportCurrentPosition().catch(fail);
      void restoreDelivery().catch(fail);
    }
  }, [auth.state, auth.viewer?.riderAvailability, fail, reportCurrentPosition, restoreDelivery]);

  useEffect(() => {
    if (!api.configured || !online || auth.state !== 'authenticated') return;
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        // Android may suspend foreground GPS while DASH is backgrounded. As
        // soon as the rider returns, push a fresh fix immediately rather than
        // waiting for the next watchPosition callback — and ask dispatch at
        // once, so an offer made while the app was hidden is not left to the
        // next eight-second poll.
        void reportCurrentPosition().catch(fail);
        void findOffers();
      }
    });
    return () => subscription.remove();
  }, [auth.state, fail, findOffers, online, reportCurrentPosition]);

  const goOnline = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      if (!api.configured) {
        setError(NOT_CONNECTED);
        return false;
      }
      await api.request('/v1/rider/availability', { method: 'POST', body: { availability: 'idle' } });
      // Going online starts a new server lease. Do not let a very recent fix
      // from the previous online session suppress the first fresh report.
      lastLocationUploadAt.current = 0;
      if (!(await reportCurrentPosition())) {
        await api.request('/v1/rider/availability', { method: 'POST', body: { availability: 'offline' } }).catch(() => undefined);
        return false;
      }
      await restoreDelivery();
      setOnline(true);
      return true;
    } catch (caught) {
      fail(caught);
      return false;
    } finally {
      setBusy(false);
    }
  }, [fail, reportCurrentPosition, restoreDelivery]);

  const goOffline = useCallback(async (): Promise<boolean> => {
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
    clearCompletedDelivery: () => setDelivery((current) => (current?.status === 'delivered' ? null : current)),
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
