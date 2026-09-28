/**
 * Whether the rider is Online — the one switch a rider's whole shift hangs on.
 *
 * Wired to the server when the build has one:
 *
 * - Going Online asks for the phone's location at that moment (foreground
 *   only), tells the server the rider is available (POST /v1/rider/
 *   availability), reports a first position, then keeps reporting every 20
 *   seconds and asks for offers every 5 — only while the app is in the
 *   foreground. A new offer opens the offer screen.
 * - Going Offline is one tap, stops every timer and tells the server. There
 *   is no background tracking: a rider who puts the app away stops reporting,
 *   and the server's online lease lapses by itself, so nothing is dispatched
 *   to a phone in a pocket.
 * - After the app restarts, the server's own record (GET /v1/auth/me) says
 *   whether this rider was online, and the shift resumes from that instead
 *   of silently showing Offline while the server still thinks otherwise.
 *
 * Every rule that decides whether an offer may reach this rider stays on the
 * server. The app reflects that state; it never decides it.
 *
 * A build with no server keeps the old device-only switch, and the screens say
 * it is a preview.
 */

import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { api } from '../api';
import { ApiError } from '../api/errors';
import { listOffers, reportLocation, setAvailability, type RiderOffer } from '../data/rider';
import { useAuth } from './AuthProvider';

const LOCATION_EVERY_MS = 20_000;
const OFFERS_EVERY_MS = 5_000;

interface RiderShiftValue {
  online: boolean;
  /** Going online or offline is in flight. */
  switching: boolean;
  /** Why the last switch failed, in words for the rider. */
  problem: string | null;
  /** Offers the server holds for this rider right now. */
  offers: readonly RiderOffer[];
  /** True when this build talks to a server; false for the device-only preview. */
  live: boolean;
  setOnline: (next: boolean) => void;
}

const RiderShiftContext = createContext<RiderShiftValue | null>(null);

export function RiderShiftProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const auth = useAuth();
  const live = api.configured && auth.state === 'authenticated' && auth.viewer?.riderStatus === 'approved';

  const [online, setOnlineState] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [offers, setOffers] = useState<readonly RiderOffer[]>([]);
  const shown = useRef(new Set<string>());
  const timers = useRef<ReturnType<typeof setInterval>[]>([]);

  const stopLoops = useCallback(() => {
    for (const timer of timers.current) clearInterval(timer);
    timers.current = [];
  }, []);

  const sendPosition = useCallback(async () => {
    if (AppState.currentState !== 'active') return;
    try {
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      await reportLocation(api, {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        heading: position.coords.heading,
        speed: position.coords.speed,
      });
    } catch {
      // A missed fix is not fatal; the next tick tries again, and the server
      // refuses acceptance on a stale position by itself.
    }
  }, []);

  const pollOffers = useCallback(async () => {
    if (AppState.currentState !== 'active') return;
    try {
      const current = await listOffers(api);
      setOffers(current);
      const fresh = current.find((offer) => !shown.current.has(offer.id));
      if (fresh) {
        shown.current.add(fresh.id);
        router.push(`/rider/offer/${fresh.id}`);
      }
    } catch {
      // Transient; asked again in five seconds.
    }
  }, [router]);

  const startLoops = useCallback(() => {
    stopLoops();
    void sendPosition();
    void pollOffers();
    timers.current = [setInterval(() => void sendPosition(), LOCATION_EVERY_MS), setInterval(() => void pollOffers(), OFFERS_EVERY_MS)];
  }, [pollOffers, sendPosition, stopLoops]);

  const setOnline = useCallback(
    (next: boolean) => {
      if (!live) {
        // Device-only preview: nothing is sent anywhere.
        setOnlineState(next);
        return;
      }
      setProblem(null);
      setSwitching(true);
      void (async () => {
        try {
          if (next) {
            const permission = await Location.requestForegroundPermissionsAsync();
            if (permission.status !== 'granted') {
              setProblem(
                permission.canAskAgain
                  ? 'DASH needs your location while you are online, so orders near you can be offered. Allow it to go online.'
                  : 'Location is turned off for DASH. Turn it on in Settings to go online.',
              );
              return;
            }
            await setAvailability(api, 'idle');
            setOnlineState(true);
            startLoops();
          } else {
            stopLoops();
            setOnlineState(false);
            setOffers([]);
            await setAvailability(api, 'offline');
          }
        } catch (error) {
          setProblem(error instanceof ApiError ? error.message : 'That did not go through. Check your connection and try again.');
        } finally {
          setSwitching(false);
        }
      })();
    },
    [live, startLoops, stopLoops],
  );

  // Resume what the server says after a restart.
  const serverAvailability = auth.viewer?.riderAvailability ?? null;
  useEffect(() => {
    if (!live) return;
    if (serverAvailability === 'idle' || serverAvailability === 'on_delivery') {
      setOnlineState(true);
      startLoops();
    }
    return stopLoops;
  }, [live, serverAvailability, startLoops, stopLoops]);

  // Back in the foreground while online: report and look for offers at once.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && online && live) {
        void sendPosition();
        void pollOffers();
      }
    });
    return () => subscription.remove();
  }, [live, online, pollOffers, sendPosition]);

  const value = useMemo<RiderShiftValue>(
    () => ({ online, switching, problem, offers, live, setOnline }),
    [online, switching, problem, offers, live, setOnline],
  );
  return <RiderShiftContext.Provider value={value}>{children}</RiderShiftContext.Provider>;
}

export function useRiderShift(): RiderShiftValue {
  const value = useContext(RiderShiftContext);
  if (!value) throw new Error('useRiderShift must be used inside <RiderShiftProvider>.');
  return value;
}
