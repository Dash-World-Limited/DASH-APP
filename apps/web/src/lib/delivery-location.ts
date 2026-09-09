'use client';

/**
 * Where the customer is ordering to.
 *
 * One answer, shared by the shell and every screen that asks a distance
 * question. Before this, Home and each section page each held their own copy of
 * the same Victoria Island constant and each decided independently whether to
 * replace it with the customer's address — so the header could say one thing
 * while the list below it was computed from somewhere else, and a section page
 * never adopted the address at all. Distance, serviceability, delivery fees and
 * "is this vendor near me" are all the same question, and it should have one
 * answer.
 *
 * ## What it will not do
 *
 * It never claims more than it knows. Until a signed-in customer's address or a
 * device fix replaces it, the position is an admitted guess, and `source` says
 * so, so the shell can offer to fix it rather than quietly present a default as
 * the customer's own address. The label shown to the customer is always the
 * *server's* answer for the position in use — a zone or city name from
 * `/v1/serviceability` — never a name this module invented.
 *
 * A device fix is requested only when the customer asks for one. Nothing here
 * polls, watches, or reads a position in the background.
 */

import { useEffect, useSyncExternalStore } from 'react';

import { apiFetch } from './api';
import { authedFetch, hasSession, subscribeToSession } from './session';

export interface Position {
  latitude: number;
  longitude: number;
}

/**
 * Where to look from before anything better is known.
 *
 * Only a starting guess, and marked as one. Answering "do you deliver here?"
 * about a fixed point in Victoria Island is answering a question nobody asked:
 * a customer whose address is anywhere else is told the service is unavailable
 * while their actual address is perfectly serviceable.
 */
export const DEFAULT_POSITION: Position = { latitude: 6.4281, longitude: 3.4219 };

export interface Serviceability {
  serviceable: boolean;
  reason?: string;
  message?: string;
  city: { id: string; name: string; slug: string } | null;
  zone?: { id: string; name: string } | null;
  busy?: boolean;
}

export type PositionSource = 'default' | 'address' | 'device';

export interface DeliveryLocation {
  position: Position;
  /** How we came by it. `default` means "we are guessing", and it is shown. */
  source: PositionSource;
  /** The server's answer for this position, or null while it is unknown. */
  serviceability: Serviceability | null;
  /** A device fix is in flight. */
  locating: boolean;
}

const INITIAL: DeliveryLocation = {
  position: DEFAULT_POSITION,
  source: 'default',
  serviceability: null,
  locating: false,
};

let state: DeliveryLocation = INITIAL;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function set(patch: Partial<DeliveryLocation>): void {
  state = { ...state, ...patch };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = (): DeliveryLocation => state;
/** The server renders the honest starting state: a guess, nothing resolved. */
const getServerSnapshot = (): DeliveryLocation => INITIAL;

/**
 * Ask the server what it makes of the current position.
 *
 * Serviceability is the server's decision, not the client's — the zone, the
 * city and whether it is busy are all things only it knows, and a client that
 * decided for itself would be wrong the moment coverage changed.
 */
async function resolveServiceability(position: Position): Promise<void> {
  const query = new URLSearchParams({
    latitude: String(position.latitude),
    longitude: String(position.longitude),
  });
  try {
    const answer = await apiFetch<Serviceability>(`/v1/serviceability?${query.toString()}`);
    // Discard a late answer for a position we have since moved away from,
    // rather than letting it overwrite a newer one.
    if (state.position === position) set({ serviceability: answer });
  } catch {
    // Leave the previous answer standing. A failed lookup is not evidence that
    // the area is unserviceable, and saying so would be worse than saying
    // nothing.
  }
}

export function setPosition(position: Position, source: PositionSource): void {
  set({ position, source, serviceability: null });
  void resolveServiceability(position);
}

/**
 * Adopt the signed-in customer's own default address.
 *
 * Called by the shell, once a session exists. A device fix already chosen by
 * the customer outranks it — they asked for that explicitly and this runs
 * whenever a session appears.
 */
export async function adoptDefaultAddress(): Promise<void> {
  // Read through a function rather than off `state` directly. The check is made
  // twice on purpose — once before the request and once after it — because the
  // customer can tap "Use my location" while it is in flight, and reading the
  // field inline would let the compiler narrow the second check away on the
  // assumption that nothing changed across the await. Something can.
  const sourceNow = (): PositionSource => state.source;

  if (!hasSession() || sourceNow() === 'device') return;
  try {
    const result = await authedFetch<{
      addresses: { latitude: number; longitude: number; isDefault: boolean }[];
    }>('/v1/addresses');
    const preferred = result.addresses.find((a) => a.isDefault) ?? result.addresses[0];
    if (preferred && sourceNow() !== 'device') {
      setPosition({ latitude: preferred.latitude, longitude: preferred.longitude }, 'address');
    }
  } catch {
    // Keep the guess. A failure here is not worth interrupting browsing.
  }
}

/** A one-off device fix, only ever in response to the customer asking. */
export function locateWithDevice(): void {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return;
  set({ locating: true });
  navigator.geolocation.getCurrentPosition(
    (result) => {
      set({ locating: false });
      setPosition({ latitude: result.coords.latitude, longitude: result.coords.longitude }, 'device');
    },
    () => {
      // Refused or unavailable. Keep what we have and say nothing alarming —
      // the customer can still browse.
      set({ locating: false });
    },
    { timeout: 8000 },
  );
}

/**
 * What to show the customer, in words.
 *
 * Only ever the server's own name for the place, so the shell cannot invent a
 * neighbourhood. Null while nothing has been resolved, so a caller renders a
 * prompt rather than a placeholder that looks like an answer.
 */
export function locationLabel(location: DeliveryLocation): string | null {
  const service = location.serviceability;
  if (!service) return null;
  if (!service.serviceable) return 'Outside our delivery area';
  return service.zone?.name ?? service.city?.name ?? null;
}

/**
 * The shared location.
 *
 * The first component to mount resolves the current position and adopts the
 * customer's address if there is a session; later mounts read the same state.
 * Re-runs when the session changes, so signing in mid-visit moves the customer
 * to their own address without a reload.
 */
export function useDeliveryLocation(): DeliveryLocation {
  const location = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    if (state.serviceability === null) void resolveServiceability(state.position);
    void adoptDefaultAddress();
    return subscribeToSession(() => {
      void adoptDefaultAddress();
    });
  }, []);

  return location;
}
