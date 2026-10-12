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
  pickupDistanceMetres: number;
  order: {
    code: string;
    pickup: { name: string; address: string; latitude: number; longitude: number };
    dropoffArea: { latitude: number; longitude: number } | null;
    tripDistanceMetres: number;
    itemCount: number;
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
}

interface ApiRiderDelivery {
  id: string;
  code: string;
  status: DeliveryStatus;
  branch: RiderDelivery['branch'];
  address: RiderDelivery['address'] | null;
  items: readonly { nameSnapshot: string; quantity: number }[];
}

interface RiderFlowValue {
  online: boolean;
  busy: boolean;
  error: string | null;
  offer: RiderOffer | null;
  delivery: RiderDelivery | null;
  riderPosition: Coordinate | null;
  goOnline(): Promise<boolean>;
  goOffline(): Promise<boolean>;
  findOffers(): Promise<void>;
  respondToOffer(accept: boolean): Promise<string | null>;
  progress(to: Exclude<DeliveryStatus, 'rider_assigned' | 'delivered'>): Promise<boolean>;
  complete(pin: string): Promise<boolean>;
  clearError(): void;
}

/**
 * The message for a rider action attempted on a build with no API address.
 *
 * This used to be a preview mode: an invented offer, an invented delivery
 * address and a fixed handover PIN, all compiled into every build. The app's front door now requires a signed-in session, which requires
 * an API, so no rider screen can mount on an unconnected build and the preview
 * could never run — it only shipped invented people and places inside the
 * bundle. A rider action without an API now refuses, plainly.
 */
const NOT_CONNECTED = 'This build has no DASH API address, so rider actions are unavailable.';

const RiderFlowContext = createContext<RiderFlowValue | null>(null);

const LOCATION_UPLOAD_INTERVAL_MS = 5_000;

export function RiderFlowProvider({ children }: { children: ReactNode }) {
  const auth = useAppSession();
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offer, setOffer] = useState<RiderOffer | null>(null);
  const [delivery, setDelivery] = useState<RiderDelivery | null>(null);
  const [riderPosition, setRiderPosition] = useState<Coordinate | null>(null);
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
      setOffer(response.offers[0] ?? null);
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

  const restoreDelivery = useCallback(async () => {
    if (!api.configured) return;
    const response = await api.request<{ deliveries: ApiRiderDelivery[] }>('/v1/rider/deliveries');
    const active = response.deliveries[0];
    setDelivery(active ? normaliseDelivery(active) : null);
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
        // waiting for the next watchPosition callback.
        void reportCurrentPosition().catch(fail);
      }
    });
    return () => subscription.remove();
  }, [auth.state, fail, online, reportCurrentPosition]);

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
    progress,
    complete,
    clearError: () => setError(null),
  }), [busy, complete, delivery, error, findOffers, goOffline, goOnline, offer, online, progress, respondToOffer, riderPosition]);

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
  };
}
