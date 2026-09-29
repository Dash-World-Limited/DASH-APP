import * as Location from 'expo-location';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

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
  preview: boolean;
  online: boolean;
  busy: boolean;
  error: string | null;
  offer: RiderOffer | null;
  delivery: RiderDelivery | null;
  riderPosition: Coordinate;
  goOnline(): Promise<boolean>;
  goOffline(): Promise<boolean>;
  findOffers(): Promise<void>;
  previewOffer(): void;
  respondToOffer(accept: boolean): Promise<string | null>;
  progress(to: Exclude<DeliveryStatus, 'rider_assigned' | 'delivered'>): Promise<boolean>;
  complete(pin: string): Promise<boolean>;
  clearError(): void;
}

const PICKUP = { latitude: 6.4474, longitude: 3.4722 };
const RIDER_START = { latitude: 6.4406, longitude: 3.4623 };

function makePreviewOffer(): RiderOffer {
  return {
    id: 'preview-offer-1',
    expiresAt: new Date(Date.now() + 90_000).toISOString(),
    pickupDistanceMetres: 1_200,
    order: {
      code: 'DASH782910',
      pickup: { name: 'Urban Bites', address: '12 Admiralty Way, Lekki Phase 1', ...PICKUP },
      dropoffArea: { latitude: 6.438, longitude: 3.526 },
      tripDistanceMetres: 4_800,
      itemCount: 3,
    },
  };
}

function makePreviewDelivery(): RiderDelivery {
  return {
    id: 'preview-delivery-1',
    code: 'DASH782910',
    status: 'rider_assigned',
    branch: { name: 'Urban Bites', address: '12 Admiralty Way, Lekki Phase 1', phone: '+234 800 000 0000', ...PICKUP },
    address: {
      line1: 'Chevron Drive, Lekki',
      landmark: 'Near the second gate',
      instructions: 'Please call when you arrive.',
      contactPhone: '+234 800 000 0001',
      latitude: 6.4384,
      longitude: 3.5262,
    },
    items: [
      { name: 'Spicy Chicken Burger', quantity: 1 },
      { name: 'French Fries (Large)', quantity: 1 },
      { name: 'Iced Lemon Tea', quantity: 1 },
    ],
  };
}

const RiderFlowContext = createContext<RiderFlowValue | null>(null);

export function RiderFlowProvider({ children }: { children: ReactNode }) {
  const auth = useAppSession();
  const preview = !api.configured;
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offer, setOffer] = useState<RiderOffer | null>(null);
  const [delivery, setDelivery] = useState<RiderDelivery | null>(null);
  const [riderPosition, setRiderPosition] = useState<Coordinate>(RIDER_START);

  const fail = useCallback((caught: unknown) => {
    setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.');
  }, []);

  const reportCurrentPosition = useCallback(async (): Promise<boolean> => {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) {
      setError('Location permission is required while a rider is online.');
      return false;
    }
    const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    const point = { latitude: position.coords.latitude, longitude: position.coords.longitude };
    setRiderPosition(point);
    if (api.configured) {
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
    }
    return true;
  }, []);

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
    const timer = setInterval(() => {
      void reportCurrentPosition().catch(fail);
    }, 20_000);
    return () => clearInterval(timer);
  }, [fail, online, reportCurrentPosition]);

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
    if (working) void restoreDelivery().catch(fail);
  }, [auth.state, auth.viewer?.riderAvailability, fail, restoreDelivery]);

  const goOnline = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      if (api.configured) {
        await api.request('/v1/rider/availability', { method: 'POST', body: { availability: 'idle' } });
        if (!(await reportCurrentPosition())) {
          await api.request('/v1/rider/availability', { method: 'POST', body: { availability: 'offline' } }).catch(() => undefined);
          return false;
        }
        await restoreDelivery();
      }
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
        setOffer(null);
        if (!accept) return null;
        const next = makePreviewDelivery();
        setDelivery(next);
        return next.id;
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
      if (api.configured) {
        await api.request(`/v1/rider/deliveries/${encodeURIComponent(delivery.id)}/progress`, { method: 'POST', body: { to } });
      }
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
      if (!api.configured && pin !== '2468') {
        setError('For this interactive preview, enter 2468.');
        return false;
      }
      if (api.configured) {
        await api.request(`/v1/rider/deliveries/${encodeURIComponent(delivery.id)}/complete`, {
          method: 'POST',
          body: { pin, latitude: riderPosition.latitude, longitude: riderPosition.longitude },
        });
      }
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
    preview,
    online,
    busy,
    error,
    offer,
    delivery,
    riderPosition,
    goOnline,
    goOffline,
    findOffers,
    previewOffer: () => setOffer(makePreviewOffer()),
    respondToOffer,
    progress,
    complete,
    clearError: () => setError(null),
  }), [busy, complete, delivery, error, findOffers, goOffline, goOnline, offer, online, preview, progress, respondToOffer, riderPosition]);

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
