/**
 * The rider's side of a delivery, against the real API.
 *
 * Every rule that decides whether a rider may take or progress an order —
 * approval, the online lease, capacity, zone, distance, and a position no
 * older than 120 seconds at acceptance — is the server's. This module sends
 * what the rider did (went online, reported a position, accepted, arrived,
 * picked up, delivered with the customer's PIN) and shows what the server
 * answers. Two riders racing for one offer are settled by the server's
 * atomic claim; the loser is told plainly that someone else took it.
 *
 * Privacy: an offer carries the drop-off *area* only; the address and the
 * customer's phone arrive with the delivery, after acceptance.
 */

import type { ApiClient } from '../api/client';

export type RiderAvailability = 'offline' | 'idle' | 'on_break';

export interface RiderOffer {
  id: string;
  expiresAt: string;
  pickupEtaSeconds: number;
  pickupDistanceMetres: number;
  order: {
    code: string;
    pickup: { name: string; address: string; latitude: number; longitude: number };
    dropoffArea: { latitude: number; longitude: number } | null;
    tripDistanceMetres: number | null;
    itemCount: number;
    estimatedReadyAt: string | null;
  };
}

export type DeliveryStatus = 'rider_assigned' | 'rider_arrived' | 'picked_up' | 'en_route' | 'arrived' | 'delivered' | string;

export interface RiderDelivery {
  id: string;
  code: string;
  status: DeliveryStatus;
  contactless: boolean;
  instructions: string | null;
  distanceMetres: number | null;
  estimatedReadyAt: string | null;
  branch: { name: string; address: string; phone: string | null; latitude: number; longitude: number };
  address: { line1: string; landmark: string | null; instructions: string | null; contactPhone: string; latitude: number; longitude: number } | null;
  items: { nameSnapshot: string; quantity: number }[];
  vendor: { name: string };
}

// ---------------------------------------------------------------- the sequence

export type ProgressTarget = 'rider_arrived' | 'picked_up' | 'en_route' | 'arrived';

/**
 * The one next thing the rider does from each state, in the server's order.
 * `complete` is the delivery itself, which needs the customer's PIN.
 */
export function nextStep(status: DeliveryStatus): { kind: 'progress'; to: ProgressTarget; label: string } | { kind: 'complete'; label: string } | null {
  switch (status) {
    case 'rider_assigned':
      return { kind: 'progress', to: 'rider_arrived', label: 'I have arrived at the shop' };
    case 'rider_arrived':
      return { kind: 'progress', to: 'picked_up', label: 'I have picked up the order' };
    case 'picked_up':
      return { kind: 'progress', to: 'en_route', label: 'Start the delivery' };
    case 'en_route':
      return { kind: 'progress', to: 'arrived', label: 'I have arrived at the customer' };
    case 'arrived':
      return { kind: 'complete', label: 'Enter the delivery PIN' };
    default:
      return null;
  }
}

/** Whether the rider is still heading to the shop (so navigation targets the pickup). */
export function headingToPickup(status: DeliveryStatus): boolean {
  return status === 'rider_assigned' || status === 'rider_arrived';
}

export const PIN_PATTERN = /^\d{4}$/;

// ---------------------------------------------------------------- calls

export function setAvailability(api: ApiClient, availability: RiderAvailability): Promise<unknown> {
  return api.request('/v1/rider/availability', { method: 'POST', body: { availability } });
}

export function reportLocation(
  api: ApiClient,
  position: { latitude: number; longitude: number; accuracy?: number | null; heading?: number | null; speed?: number | null },
): Promise<unknown> {
  return api.request('/v1/rider/location', {
    method: 'POST',
    body: {
      latitude: position.latitude,
      longitude: position.longitude,
      ...(position.accuracy != null && position.accuracy >= 0 ? { accuracy: Math.min(position.accuracy, 10_000) } : {}),
      ...(position.heading != null && position.heading >= 0 && position.heading <= 360 ? { heading: position.heading } : {}),
      ...(position.speed != null && position.speed >= 0 && position.speed <= 100 ? { speed: position.speed } : {}),
      recordedAt: new Date().toISOString(),
    },
  });
}

export async function listOffers(api: ApiClient): Promise<RiderOffer[]> {
  return (await api.request<{ offers: RiderOffer[] }>('/v1/rider/offers')).offers;
}

export function respondToOffer(api: ApiClient, offerId: string, accept: boolean, declineReason?: string): Promise<{ accepted?: boolean; orderId?: string }> {
  return api.request(`/v1/rider/offers/${encodeURIComponent(offerId)}/respond`, {
    method: 'POST',
    body: { accept, ...(declineReason ? { declineReason } : {}) },
  });
}

export async function listDeliveries(api: ApiClient): Promise<RiderDelivery[]> {
  return (await api.request<{ deliveries: RiderDelivery[] }>('/v1/rider/deliveries')).deliveries;
}

export async function getDelivery(api: ApiClient, orderId: string): Promise<RiderDelivery> {
  return (await api.request<{ delivery: RiderDelivery }>(`/v1/rider/deliveries/${encodeURIComponent(orderId)}`)).delivery;
}

export function progressDelivery(api: ApiClient, orderId: string, to: ProgressTarget): Promise<unknown> {
  return api.request(`/v1/rider/deliveries/${encodeURIComponent(orderId)}/progress`, { method: 'POST', body: { to } });
}

export interface RiderEarnings {
  /** What DASH owes this rider now, from the ledger. */
  balanceOwed: number;
  completedDeliveries: number;
  recentEntries: { amount: number; memo: string | null; at: string }[];
}

export function getEarnings(api: ApiClient): Promise<RiderEarnings> {
  return api.request<RiderEarnings>('/v1/rider/earnings');
}

export function completeDelivery(api: ApiClient, orderId: string, pin: string, position?: { latitude: number; longitude: number }): Promise<unknown> {
  return api.request(`/v1/rider/deliveries/${encodeURIComponent(orderId)}/complete`, {
    method: 'POST',
    body: { pin, ...(position ? { latitude: position.latitude, longitude: position.longitude } : {}) },
  });
}
