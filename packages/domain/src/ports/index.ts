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

/** The provider's account of one refund. See `PaymentPort.lookupRefund`. */
export interface RefundLookup {
  /** The provider's id for the refund, normalised; stored against our refund. */
  readonly refundReference: string;
  /** False when the provider has no such refund, or it is for another transaction. */
  readonly matchesPayment: boolean;
  /** `processed` is the only state meaning the money has gone back. */
  readonly status: 'processed' | 'pending' | 'failed';
  readonly amount: Kobo;
  readonly currency: string;
  /** The provider's own word for the state (e.g. `needs-attention`), for staff. */
  readonly providerStatus: string;
}

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

/** A bank the payment provider can pay into, by the provider's own code for it. */
export interface PayoutBank {
  readonly code: string;
  readonly name: string;
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
   * Ask the provider about one refund, and whether it belongs to this payment.
   *
   * `refundReference` is what a person copied from the provider's dashboard;
   * `providerReference` is our payment's reference. A refund the provider does
   * not know, or one made against a different transaction, comes back with
   * `matchesPayment: false`. Throws when the provider cannot be asked — "could
   * not ask" must never read as "not found".
   */
  lookupRefund(input: { refundReference: string; providerReference: string }): Promise<RefundLookup>;

  /**
   * Nigerian banks the provider can pay into. Throws when the provider cannot
   * be asked.
   */
  listBanks(): Promise<readonly PayoutBank[]>;

  /**
   * The name a bank holds for an account, as the bank reports it through the
   * provider. Null when the bank says there is no such account. Throws when
   * the provider cannot be asked — "could not ask" must never read as "no
   * such account", or a rider would be told their real account is wrong.
   */
  resolveBankAccount(input: { bankCode: string; accountNumber: string }): Promise<{ accountName: string } | null>;

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

/**
 * What a push provider tells us after a send.
 *
 * `invalidTokens` is the part that matters operationally. A push token dies
 * without warning — the app is uninstalled, the OS reissues it, the user wipes
 * the device — and the provider only tells you when you try to use it. Without
 * somewhere to report that, a table of dead tokens grows for ever and every
 * send wastes calls on handsets that no longer exist.
 *
 * Reporting them is not the same as deleting them: the port describes what the
 * provider said, and the caller decides what to do about it.
 */
export interface PushReceipt extends DeliveryReceipt {
  /**
   * Tokens the provider refused as unregistered or malformed. These are dead
   * for good and should be removed — unlike a transient failure, retrying will
   * never make them work.
   */
  readonly invalidTokens?: readonly string[];
}

export interface PushPort {
  readonly providerName: string;
  readonly isLive: boolean;
  send(input: {
    deviceTokens: readonly string[];
    title: string;
    body: string;
    data?: Readonly<Record<string, string>> | undefined;
  }): Promise<PushReceipt>;
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
// Data-export archives
// ---------------------------------------------------------------------------

/**
 * Where a built personal-data export is held until the subject downloads it.
 *
 * Deliberately separate from `StoragePort`:
 *
 *   - `StoragePort` is for user uploads and carries an image/PDF allowlist and
 *     an 8 MB cap. An export archive is neither an upload nor necessarily small.
 *   - An export archive is the single most sensitive object the platform ever
 *     writes — one person's entire history in one file. It deserves its own
 *     retention and access story, not a shared bucket.
 *
 * There is no `signedUrl`. The download goes through an authenticated API route
 * that checks a single-use token and streams the bytes, so access control stays
 * on our side rather than resting on a storage provider's URL-expiry semantics.
 */
export interface ExportArchivePort {
  readonly providerName: string;
  readonly isLive: boolean;

  /** Store an archive under `key`. Returns the byte length actually written. */
  write(input: { key: string; body: Buffer; contentType: string }): Promise<{ sizeBytes: number }>;

  read(key: string): Promise<Buffer>;

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
// Realtime fan-out
// ---------------------------------------------------------------------------

/**
 * Carries one notification to every server instance.
 *
 * ## Why this is not the queue
 *
 * The queue and this port look similar and do opposite things. A queue job is
 * delivered to **exactly one** consumer — that is what stops two instances
 * dispatching the same order twice, and it is the property `QueuePort` exists
 * to provide. A realtime notification has to reach **every** instance, because
 * the customer watching order `abc` is connected to whichever instance a load
 * balancer happened to pick, and that is almost never the instance whose worker
 * picked up the job.
 *
 * Sending a notification through the queue alone would deliver it to one
 * instance, which would fan it out to its own sockets and silently drop it for
 * everyone connected elsewhere. The symptom is the worst kind: it works
 * perfectly on a single-instance development machine and loses most updates in
 * production, in proportion to how well the deployment is scaled.
 *
 * So the path is queue *then* broadcast: the outbox relay publishes a job, one
 * worker consumes it, and that worker hands it to this port, which repeats it
 * to every instance including its own. The queue keeps the delivery durable and
 * exactly-once-ish; this makes it universal.
 *
 * ## Failure mode: degradable
 *
 * If the broadcast channel is unavailable, notifications stop and clients fall
 * back to polling the same authorized routes they already use. Nothing is lost,
 * because nothing here is a record — the durable state committed to PostgreSQL
 * before any of this began. That classification is registered in
 * `REDIS_RESPONSIBILITIES` and asserted by `redis.test.ts`.
 */
export interface RealtimeBroadcastPort {
  readonly providerName: string;

  /**
   * Repeat a notification to every instance, including this one.
   *
   * Local delivery must not depend on the round trip succeeding: an instance
   * that cannot reach the channel still serves its own sockets correctly.
   */
  publish(notification: unknown): Promise<void>;

  /**
   * Register the handler that receives notifications from any instance.
   *
   * The payload is `unknown` deliberately. It has crossed a process boundary on
   * shared infrastructure, so the handler validates it before believing a word
   * of it — see `parseNotification` in `@dash/domain/realtime`.
   */
  subscribe(handler: (notification: unknown) => void): void;

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
