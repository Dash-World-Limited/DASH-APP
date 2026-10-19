/**
 * The customer's delivery location, for the line under DASH on the home
 * screen and the screen it opens.
 *
 * A confirmed location is the customer's default saved address — the one
 * checkout already picks first — so there is one address system, not two.
 * Until there is one, the line shows where the phone is, reverse-geocoded.
 *
 * Detection is remembered for the app session: the home screen unmounts each
 * time the customer opens another screen, and coming back must not mean
 * another GPS fix, or another permission dialog. From here the dialog is
 * offered only to a customer who has never been asked, and at most once a
 * session; after a refusal only a tap asks again.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../api';
import { listAddresses, type Address } from '../../data/orders';
import { describePlace, type HomeLocation } from '../../features/delivery';
import { detectCurrentPlace, type PermissionAsk, type PlaceResult } from '../../features/deviceLocation';
import { useAppSession } from '../auth/AppSessionProvider';
import { useIosLocationResume } from './useIosLocationResume';

const DETECTION_TTL_MS = 5 * 60_000;

interface Detected {
  at: number;
  result: PlaceResult;
}

let lastDetection: Detected | null = null;
let askedThisSession = false;
let inFlight: Promise<PlaceResult> | null = null;

/** For tests: forget the session's detection and permission prompt. */
export function resetDeliveryLocationSession(): void {
  lastDetection = null;
  askedThisSession = false;
  inFlight = null;
}

/** The last detection this session, if it is still fresh. */
export function recentDetection(): PlaceResult | null {
  return lastDetection && Date.now() - lastDetection.at < DETECTION_TTL_MS ? lastDetection.result : null;
}

/**
 * Where the phone is. `ask` is the customer asking (opening the location
 * screen, or tapping "Allow location"); without it the system dialog is
 * offered only to a customer never asked before, once a session. Concurrent
 * callers share one fix.
 */
export function detectPlace({ ask, fresh = false }: { ask: boolean; fresh?: boolean }): Promise<PlaceResult> {
  const recent = fresh ? null : recentDetection();
  if (recent && (recent.ok || !ask)) return Promise.resolve(recent);
  if (inFlight) return inFlight;
  const permissionAsk: PermissionAsk = ask ? 'always' : askedThisSession ? 'never' : 'first-time';
  askedThisSession = true;
  return startDetection(permissionAsk);
}

function startDetection(ask: PermissionAsk): Promise<PlaceResult> {
  const work = detectCurrentPlace({ ask })
    .then((result) => {
      // A pre-suspension fix must not restore coordinates after access was
      // revoked in Settings, or overwrite a newer post-resume result.
      if (inFlight === work) lastDetection = { at: Date.now(), result };
      return result;
    })
    .finally(() => {
      if (inFlight === work) inFlight = null;
    });
  inFlight = work;
  return work;
}

/** Bypass cached permission/coordinates on iOS resume, without opening a dialog. */
export function resumePlaceDetection(): Promise<PlaceResult> {
  lastDetection = null;
  return startDetection('never');
}

export function homeLocationFrom(result: PlaceResult): HomeLocation {
  if (result.ok) return { kind: 'detected', description: describePlace(result.place) };
  return result.reason === 'denied' ? { kind: 'denied', canAskAgain: result.canAskAgain } : { kind: 'unavailable' };
}

export function useDeliveryLocation(): { location: HomeLocation; defaultAddress: Address | null } {
  const { state: sessionState } = useAppSession();
  const [location, setLocation] = useState<HomeLocation>({ kind: 'loading' });
  const [defaultAddress, setDefaultAddress] = useState<Address | null>(null);
  const generation = useRef(0);

  const load = useCallback(async (resuming = false) => {
    const mine = ++generation.current;
    if (resuming) {
      // Settings may have changed access even when the saved address wins.
      // Invalidate before the address read, without requesting another fix.
      lastDetection = null;
      inFlight = null;
    }
    if (sessionState === 'authenticated' && api.configured) {
      try {
        const saved = (await listAddresses(api)).find((address) => address.isDefault) ?? null;
        if (mine !== generation.current) return;
        if (saved) {
          setDefaultAddress(saved);
          setLocation({ kind: 'confirmed', label: saved.label, line1: saved.line1 });
          return;
        }
      } catch {
        // No saved list to read: fall through to where the phone is.
      }
    }
    if (mine !== generation.current) return;
    setDefaultAddress(null);
    const result = await (resuming ? resumePlaceDetection() : detectPlace({ ask: false }));
    if (mine === generation.current) setLocation(homeLocationFrom(result));
  }, [sessionState]);

  const resume = useCallback(() => {
    if (sessionState !== 'restoring') void load(true);
  }, [load, sessionState]);
  useIosLocationResume(resume);

  useEffect(() => {
    // Wait for the session to settle, so a signed-in customer's saved address
    // is not briefly replaced by a GPS guess.
    if (sessionState === 'restoring') return;
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load, sessionState]);

  return { location, defaultAddress };
}
