/**
 * Ports — the boundary between DASH APP's domain and everything external.
 *
 * Each interface here has at least one offline implementation used by default in
 * development and tests, and a real implementation that is only wired up when
 * credentials exist (ADR-0005).
 *
 * Nothing in this file makes a network call. These are contracts only.
 *
 * IMPORTANT: an interface existing here is not a claim that the real integration
 * works. `docs/PROGRESS.md` tracks which adapters have been verified against a
 * live sandbox and which are still unproven.
 */

import type { Kobo } from '../money/index.js';
import type { LatLng } from '../geo/index.js';

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export type PaymentStatus =
  | 'pending'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'cancelled'
  | 'refunded'
  | 'partially_refunded';

export interface PaymentIntent {
  readonly providerReference: string;
  readonly status: PaymentStatus;
  readonly amount: Kobo;
  readonly currency: 'NGN';
  /** Where to send the customer to complete payment, when the provider needs it. */
  readonly authorizationUrl?: string | undefined;
  /** Provider's own failure text. Never shown raw to a customer. */
  readonly providerMessage?: string | undefined;
}

export interface PaymentWebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly providerReference: string;
  readonly status: PaymentStatus;
  readonly amount: Kobo;
  readonly occurredAt: Date;
  readonly raw: unknown;
}

export interface PaymentPort {
  readonly providerName: string;
  /** True only when the adapter is configured with real credentials. */
  readonly isLive: boolean;

  initialize(input: {
    amount: Kobo;
    currency: 'NGN';
    /** Our own reference. Must be unique and is echoed back on webhooks. */
    reference: string;
    customerEmail: string;
    /** Saved-card token, when charging a stored method. */
    paymentMethodToken?: string | undefined;
    idempotencyKey: string;
    metadata?: Readonly<Record<string, string>> | undefined;
  }): Promise<PaymentIntent>;

  /** Ask the provider what actually happened. Authoritative over client claims. */
  verify(reference: string): Promise<PaymentIntent>;

  refund(input: {
    providerReference: string;
    amount: Kobo;
    reason: string;
    idempotencyKey: string;
  }): Promise<{ refundReference: string; status: PaymentStatus }>;

  /**
   * Verify a webhook's signature and parse it.
   *
   * Returns null when the signature does not verify — the caller must treat a
   * null as a hostile request, log it, and return 200 without acting, so an
   * attacker learns nothing from the response.
   */
  parseWebhook(input: {
    rawBody: string;
    headers: Readonly<Record<string, string | undefined>>;
  }): PaymentWebhookEvent | null;
}

// ---------------------------------------------------------------------------
// Geography and routing
// ---------------------------------------------------------------------------

export interface RouteEstimate {
  readonly distanceMetres: number;
  readonly durationSeconds: number;
  readonly source: 'routing_provider' | 'haversine_with_detour_factor';
}

export interface GeocodeResult {
  readonly formattedAddress: string;
  readonly location: LatLng;
  readonly placeId?: string | undefined;
  /** How much to trust it. Low-confidence results should prompt a map pin. */
  readonly confidence: 'high' | 'medium' | 'low';
}

export interface GeoPort {
  readonly providerName: string;
  readonly isLive: boolean;

  route(from: LatLng, to: LatLng): Promise<RouteEstimate>;
  geocode(query: string, near?: LatLng): Promise<readonly GeocodeResult[]>;
  reverseGeocode(point: LatLng): Promise<GeocodeResult | null>;

  /**
   * Zones containing a point, best match first. The local implementation tests
   * polygons in process; the PostGIS one uses `ST_Contains`.
   */
  zonesContaining(point: LatLng, cityId: string): Promise<readonly string[]>;
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

export interface DeliveryReceipt {
  readonly accepted: boolean;
  readonly providerMessageId?: string | undefined;
  readonly failureReason?: string | undefined;
}

export interface SmsPort {
  readonly providerName: string;
  readonly isLive: boolean;
  /** `to` must be E.164. */
  send(input: { to: string; body: string; reference: string }): Promise<DeliveryReceipt>;
}

export interface EmailPort {
  readonly providerName: string;
  readonly isLive: boolean;
  send(input: {
    to: string;
    subject: string;
    html: string;
    text: string;
    reference: string;
  }): Promise<DeliveryReceipt>;
}

export interface PushPort {
  readonly providerName: string;
  readonly isLive: boolean;
  send(input: {
    deviceTokens: readonly string[];
    title: string;
    body: string;
    data?: Readonly<Record<string, string>> | undefined;
  }): Promise<DeliveryReceipt>;
}

// ---------------------------------------------------------------------------
// Object storage
// ---------------------------------------------------------------------------

export interface StoredObject {
  /** Random, unguessable key. Never derived from a filename. */
  readonly key: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

export interface StoragePort {
  readonly providerName: string;
  readonly isLive: boolean;

  put(input: {
    body: Buffer;
    contentType: string;
    /** Logical grouping, e.g. `vendor-docs`, `delivery-proof`. */
    prefix: string;
  }): Promise<StoredObject>;

  /** Short-lived read URL. Buckets are private; there are no public objects. */
  signedUrl(key: string, expiresInSeconds: number): Promise<string>;

  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export interface QueueJob<T> {
  readonly id: string;
  readonly name: string;
  readonly payload: T;
  readonly attempt: number;
}

export interface QueuePort {
  readonly providerName: string;

  enqueue<T>(input: {
    name: string;
    payload: T;
    /** Delay before the job becomes runnable. */
    delayMs?: number | undefined;
    /** Deduplicates — enqueuing the same key twice runs the job once. */
    idempotencyKey?: string | undefined;
    maxAttempts?: number | undefined;
  }): Promise<{ jobId: string }>;

  process<T>(name: string, handler: (job: QueueJob<T>) => Promise<void>): void;

  /** Drain and stop. Used by tests and by graceful shutdown. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/**
 * Injectable time.
 *
 * Every piece of domain logic that cares about "now" takes it from here rather
 * than calling `new Date()`, so tests over offer timeouts, surge windows,
 * promotion validity, and step-up expiry are deterministic instead of flaky.
 */
export interface ClockPort {
  now(): Date;
}

export const systemClock: ClockPort = {
  now: () => new Date(),
};

export function fixedClock(at: Date): ClockPort {
  return { now: () => new Date(at.getTime()) };
}

/** A clock the test can advance by hand. */
export function controllableClock(start: Date): ClockPort & { advance(ms: number): void } {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}
