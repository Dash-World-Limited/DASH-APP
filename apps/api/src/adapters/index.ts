/**
 * Adapter implementations.
 *
 * Every one of these is the offline default described in ADR-0005. They are
 * deterministic, need no credentials, and are honest about being mocks — each
 * reports `isLive: false`, and the boot banner prints which is in use.
 *
 * Real provider adapters go in sibling files and are selected by config. None
 * exists yet, and none will be described as working until it has been run
 * against a live sandbox.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { kobo, type Kobo } from '@dash/domain/money';
import {
  estimatedRoadMetres,
  haversineMetres,
  isPointInBoundingBox,
  isPointInPolygon,
  parsePolygon,
  type LatLng,
} from '@dash/domain/geo';
import type {
  DeliveryReceipt,
  EmailPort,
  ExportArchivePort,
  GeocodeResult,
  GeoPort,
  PaymentIntent,
  PaymentPort,
  PaymentWebhookEvent,
  PayoutBank,
  PushPort,
  QueueJob,
  QueuePort,
  RefundLookup,
  RouteEstimate,
  SmsPort,
  StoragePort,
  StoredObject,
} from '@dash/domain/ports';
import type { PrismaClient } from '@dash/db';

// ---------------------------------------------------------------------------
// Payments — mock
// ---------------------------------------------------------------------------

interface MockPaymentRecord {
  reference: string;
  amount: Kobo;
  status: PaymentIntent['status'];
  capturedAmount: Kobo;
}

const MOCK_BANKS: readonly PayoutBank[] = [
  { code: '044', name: 'Access Bank' },
  { code: '011', name: 'First Bank of Nigeria' },
  { code: '058', name: 'Guaranty Trust Bank' },
  { code: '50211', name: 'Kuda Bank' },
  { code: '50515', name: 'Moniepoint MFB' },
  { code: '999992', name: 'OPay Digital Services Limited (OPay)' },
  { code: '033', name: 'United Bank For Africa' },
  { code: '057', name: 'Zenith Bank' },
];

/**
 * A deterministic in-memory payment provider.
 *
 * Behaviour is driven by the reference so tests can force outcomes without
 * network mocking: a reference containing `fail` declines, one containing
 * `pending` stays unresolved. Everything else authorises and captures.
 */
export class MockPaymentAdapter implements PaymentPort {
  readonly providerName = 'mock';
  readonly isLive = false;

  private readonly records = new Map<string, MockPaymentRecord>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private readonly refunds = new Map<string, { providerReference: string; amount: Kobo }>();

  async initialize(input: {
    amount: Kobo;
    currency: 'NGN';
    reference: string;
    customerEmail: string;
    idempotencyKey: string;
  }): Promise<PaymentIntent> {
    // Replaying an idempotency key returns the original intent rather than
    // creating a second charge — the same contract a real provider offers.
    const existingReference = this.byIdempotencyKey.get(input.idempotencyKey);
    if (existingReference) {
      const existing = this.records.get(existingReference);
      if (existing) return this.toIntent(existing);
    }

    const status: PaymentIntent['status'] = input.reference.includes('fail')
      ? 'failed'
      : input.reference.includes('pending')
        ? 'pending'
        : 'captured';

    const record: MockPaymentRecord = {
      reference: input.reference,
      amount: input.amount,
      status,
      capturedAmount: status === 'captured' ? input.amount : kobo(0),
    };

    this.records.set(input.reference, record);
    this.byIdempotencyKey.set(input.idempotencyKey, input.reference);
    return this.toIntent(record);
  }

  async verify(reference: string): Promise<PaymentIntent> {
    const record = this.records.get(reference);
    if (!record) {
      return {
        providerReference: reference,
        status: 'failed',
        amount: kobo(0),
        currency: 'NGN',
        providerMessage: 'Unknown reference',
      };
    }
    return this.toIntent(record);
  }

  async refund(input: {
    providerReference: string;
    amount: Kobo;
    idempotencyKey: string;
  }): Promise<{ refundReference: string; status: PaymentIntent['status'] }> {
    const record = this.records.get(input.providerReference);
    if (!record) throw new Error(`Cannot refund unknown reference ${input.providerReference}`);
    if (input.amount > record.capturedAmount) {
      throw new Error('Refund exceeds the captured amount');
    }

    record.capturedAmount = kobo(record.capturedAmount - input.amount);
    record.status = record.capturedAmount === 0 ? 'refunded' : 'partially_refunded';

    const refundReference = `mock_refund_${randomUUID()}`;
    this.refunds.set(refundReference, { providerReference: input.providerReference, amount: input.amount });
    return { refundReference, status: record.status };
  }

  /**
   * Only refunds this mock itself made through `refund` exist. There is no
   * mock dashboard to refund from, so a reference typed by a person is
   * unknown here — which is the honest answer.
   */
  async lookupRefund(input: { refundReference: string; providerReference: string }): Promise<RefundLookup> {
    const refund = this.refunds.get(input.refundReference);
    return {
      refundReference: input.refundReference,
      matchesPayment: refund?.providerReference === input.providerReference,
      status: refund ? 'processed' : 'pending',
      amount: refund?.amount ?? kobo(0),
      currency: 'NGN',
      providerStatus: refund ? 'processed' : 'not_found',
    };
  }

  /**
   * A few real Nigerian banks and their codes, for development and tests
   * only. A deployment with `PAYMENTS_PROVIDER=paystack` lists Paystack's own
   * banks; nothing outside this mock reads this list.
   */
  async listBanks(): Promise<readonly PayoutBank[]> {
    return MOCK_BANKS;
  }

  /**
   * Deterministic: every 10-digit number at a listed bank resolves to a test
   * name, except 0000000000, which the bank "does not know". A number ending
   * 9999 makes the bank unreachable, for the "could not ask" path.
   */
  async resolveBankAccount(input: { bankCode: string; accountNumber: string }): Promise<{ accountName: string } | null> {
    if (input.accountNumber.endsWith('9999')) throw new Error('Mock bank lookup is unavailable');
    if (!/^\d{10}$/.test(input.accountNumber) || input.accountNumber === '0000000000') return null;
    if (!MOCK_BANKS.some((bank) => bank.code === input.bankCode)) return null;
    return { accountName: `DASH TEST ACCOUNT ${input.accountNumber.slice(-4)}` };
  }

  /**
   * Signature verification for the mock.
   *
   * Even the mock verifies a signature, because a webhook route that only
   * checks signatures in production is a route whose signature check has never
   * been tested. The scheme mirrors Paystack's: HMAC-ish digest of the body.
   */
  parseWebhook(input: {
    rawBody: string;
    headers: Readonly<Record<string, string | undefined>>;
  }): PaymentWebhookEvent | null {
    const provided = input.headers['x-dash-signature'];
    if (!provided) return null;

    const expected = createHash('sha256')
      .update(`${input.rawBody}.mock-webhook-secret`)
      .digest('hex');
    if (provided !== expected) return null;

    try {
      const parsed = JSON.parse(input.rawBody) as {
        id?: string;
        type?: string;
        reference?: string;
        status?: string;
        amount?: number;
      };
      if (!parsed.id || !parsed.reference || !parsed.type) return null;

      return {
        id: parsed.id,
        type: parsed.type,
        providerReference: parsed.reference,
        status: (parsed.status ?? 'captured') as PaymentIntent['status'],
        amount: kobo(parsed.amount ?? 0),
        occurredAt: new Date(),
        raw: parsed,
      };
    } catch {
      return null;
    }
  }

  /** Test helper — produce a correctly signed webhook body. */
  static signWebhook(rawBody: string): string {
    return createHash('sha256').update(`${rawBody}.mock-webhook-secret`).digest('hex');
  }

  private toIntent(record: MockPaymentRecord): PaymentIntent {
    return {
      providerReference: record.reference,
      status: record.status,
      amount: record.amount,
      currency: 'NGN',
      ...(record.status === 'failed' ? { providerMessage: 'Declined by issuer (mock)' } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Geo — local
// ---------------------------------------------------------------------------

/**
 * Geography without a map vendor.
 *
 * Distances are haversine scaled by the city's detour factor. Serviceability
 * loads a city's zones and tests them in process, using the cached bounding box
 * as a pre-filter so most zones are rejected without running the polygon test.
 *
 * The limitation is honest and recorded: this is correct at Lagos zone counts
 * (tens) and will not scale nationally without the PostGIS implementation.
 */
export class LocalGeoAdapter implements GeoPort {
  readonly providerName = 'local';
  readonly isLive = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly defaultDetourFactor = 1.4,
  ) {}

  async route(from: LatLng, to: LatLng): Promise<RouteEstimate> {
    const distanceMetres = estimatedRoadMetres(from, to, this.defaultDetourFactor);
    // 6.5 m/s ≈ 23 km/h — a traffic-adjusted Lagos average, not a free-flow speed.
    const durationSeconds = distanceMetres / 6.5;
    return {
      distanceMetres,
      durationSeconds,
      source: 'haversine_with_detour_factor',
    };
  }

  /**
   * Without a geocoding provider there is no address search. Returning an empty
   * list is the honest answer — the UI falls back to asking for a map pin,
   * which is what it must do when a real provider returns nothing anyway.
   */
  async geocode(_query: string, _near?: LatLng): Promise<readonly GeocodeResult[]> {
    return [];
  }

  async reverseGeocode(_point: LatLng): Promise<GeocodeResult | null> {
    return null;
  }

  async zonesContaining(point: LatLng, cityId: string): Promise<readonly string[]> {
    // Deliberately NOT filtered by `isActive`. This answers the geometric
    // question the port describes — which zones contain this point — and
    // leaves policy to the caller.
    //
    // Filtering here made `/v1/serviceability`'s `zone_paused` branch
    // unreachable: a zone paused for an hour looked identical to one that
    // never existed, so a customer in a flooded area was told DASH APP does
    // not deliver to them at all rather than to try again shortly.
    const zones = await this.prisma.zone.findMany({
      where: { cityId },
      select: {
        id: true,
        polygon: true,
        minLatitude: true,
        maxLatitude: true,
        minLongitude: true,
        maxLongitude: true,
      },
    });

    const matches: string[] = [];
    for (const zone of zones) {
      // Cheap rejection first.
      const inBox = isPointInBoundingBox(point, {
        minLatitude: zone.minLatitude,
        maxLatitude: zone.maxLatitude,
        minLongitude: zone.minLongitude,
        maxLongitude: zone.maxLongitude,
      });
      if (!inBox) continue;

      try {
        if (isPointInPolygon(point, parsePolygon(JSON.parse(zone.polygon)))) {
          matches.push(zone.id);
        }
      } catch {
        // A malformed polygon must not take down serviceability for every other
        // zone. Skip it; the nightly integrity job reports it.
        continue;
      }
    }
    return matches;
  }

  /** Straight-line distance, exposed for dispatch scoring. */
  distanceMetres(from: LatLng, to: LatLng): number {
    return haversineMetres(from, to);
  }
}

// ---------------------------------------------------------------------------
// Messaging — console
// ---------------------------------------------------------------------------

/**
 * `quiet` suppresses the console output.
 *
 * Printing the OTP is the entire point of these adapters in development, and
 * pure noise in a test run — a passing suite should not bury its own output
 * under a wall of fake SMS. The message is still "delivered"; only the printing
 * is skipped, so behaviour under test is unchanged.
 */
export class ConsoleSmsAdapter implements SmsPort {
  readonly providerName = 'console';
  readonly isLive = false;

  constructor(private readonly quiet = false) {}

  async send(input: { to: string; body: string; reference: string }): Promise<DeliveryReceipt> {
    if (!this.quiet) console.warn(`\n  [SMS → ${input.to}] ${input.body}\n`);
    return { accepted: true, providerMessageId: `console_${randomUUID()}` };
  }
}

export class ConsoleEmailAdapter implements EmailPort {
  readonly providerName = 'console';
  readonly isLive = false;

  constructor(private readonly quiet = false) {}

  async send(input: { to: string; subject: string; text: string }): Promise<DeliveryReceipt> {
    if (!this.quiet) console.warn(`\n  [EMAIL → ${input.to}] ${input.subject}\n  ${input.text}\n`);
    return { accepted: true, providerMessageId: `console_${randomUUID()}` };
  }
}

export class ConsolePushAdapter implements PushPort {
  readonly providerName = 'console';
  readonly isLive = false;

  constructor(private readonly quiet = false) {}

  async send(input: {
    deviceTokens: readonly string[];
    title: string;
    body: string;
  }): Promise<DeliveryReceipt> {
    if (!this.quiet) {
      console.warn(`\n  [PUSH ×${input.deviceTokens.length}] ${input.title} — ${input.body}\n`);
    }
    return { accepted: true, providerMessageId: `console_${randomUUID()}` };
  }
}

// ---------------------------------------------------------------------------
// Storage — local disk
// ---------------------------------------------------------------------------

/** Uploads we accept. Anything else is rejected before it touches the disk. */
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export class LocalStorageAdapter implements StoragePort {
  readonly providerName = 'local';
  readonly isLive = false;

  constructor(private readonly baseDir: string) {}

  async put(input: {
    body: Buffer;
    contentType: string;
    prefix: string;
  }): Promise<StoredObject> {
    if (!ALLOWED_MIME_TYPES.has(input.contentType)) {
      throw new Error(`Refusing to store content type ${input.contentType}`);
    }
    if (input.body.length > MAX_UPLOAD_BYTES) {
      throw new Error(`Upload exceeds ${MAX_UPLOAD_BYTES} bytes`);
    }
    if (input.body.length === 0) {
      throw new Error('Refusing to store an empty file');
    }

    // The key is random and never derived from a user-supplied filename, so a
    // filename cannot traverse a path or collide with another tenant's object.
    const safePrefix = input.prefix.replace(/[^a-z0-9-]/gi, '');
    const key = `${safePrefix}/${randomBytes(24).toString('hex')}`;
    const target = this.pathFor(key);

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, input.body);

    return { key, contentType: input.contentType, sizeBytes: input.body.length };
  }

  /**
   * A stand-in for a signed URL.
   *
   * The token is an HMAC-shaped digest over the key and expiry, so a URL cannot
   * be edited to reach a different object or extend its own life. The API
   * serves it through a route that re-checks the signature.
   */
  async signedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const signature = createHash('sha256')
      .update(`${key}.${expiresAt}.local-storage-secret`)
      .digest('hex');
    return `/v1/files/${encodeURIComponent(key)}?expires=${expiresAt}&signature=${signature}`;
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch {
      // Deleting an object that is already gone is a success, not a failure.
    }
  }

  verifySignedUrl(key: string, expiresAt: number, signature: string): boolean {
    if (expiresAt < Math.floor(Date.now() / 1000)) return false;
    const expected = createHash('sha256')
      .update(`${key}.${expiresAt}.local-storage-secret`)
      .digest('hex');
    return expected === signature;
  }

  /**
   * Resolve a key to a path, refusing anything that escapes the base directory.
   * Keys are generated by us, but this check costs nothing and turns a future
   * mistake into an error instead of an arbitrary file read.
   */
  private pathFor(key: string): string {
    const base = resolve(this.baseDir);
    const target = resolve(join(base, key));
    if (!target.startsWith(base)) {
      throw new Error('Refusing to resolve a storage key outside the base directory');
    }
    return target;
  }
}

// ---------------------------------------------------------------------------
// Export archives — local disk
// ---------------------------------------------------------------------------

/**
 * Writes personal-data export archives under `<baseDir>/data-export/`.
 *
 * Keys are generated by the caller from a random token and are validated here
 * to be a single path segment, so nothing a request influenced can steer a
 * read or write outside the directory. Kept apart from `LocalStorageAdapter`
 * because an export is not an upload and must not share the upload allowlist,
 * cap, or bucket.
 */
export class LocalExportArchiveAdapter implements ExportArchivePort {
  readonly providerName = 'local';
  readonly isLive = false;

  constructor(private readonly baseDir: string) {}

  async write(input: {
    key: string;
    body: Buffer;
    contentType: string;
  }): Promise<{ sizeBytes: number }> {
    if (input.body.length === 0) throw new Error('Refusing to write an empty export archive');
    const target = this.pathFor(input.key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, input.body);
    return { sizeBytes: input.body.length };
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch {
      // Already gone is a success.
    }
  }

  private pathFor(key: string): string {
    // One segment, our alphabet only. The API builds keys from randomBytes, so
    // this is belt-and-braces against a future caller passing something else.
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
      throw new Error('Refusing an export archive key that is not a single safe segment');
    }
    const base = resolve(join(this.baseDir, 'data-export'));
    const target = resolve(join(base, key));
    if (target !== join(base, key) || !target.startsWith(base)) {
      throw new Error('Refusing to resolve an export key outside its directory');
    }
    return target;
  }
}

// ---------------------------------------------------------------------------
// Queue — in-memory
// ---------------------------------------------------------------------------

interface PendingJob {
  id: string;
  name: string;
  payload: unknown;
  attempt: number;
  maxAttempts: number;
  runAt: number;
  timer?: NodeJS.Timeout;
}

/**
 * An in-process queue with delays, retries, and idempotent enqueue.
 *
 * Jobs are lost on restart. That is acceptable for development and is the
 * reason `QUEUE_PROVIDER=memory` is rejected in production by `config.ts`.
 */
export class MemoryQueueAdapter implements QueuePort {
  readonly providerName = 'memory';

  private readonly handlers = new Map<string, (job: QueueJob<never>) => Promise<void>>();
  private readonly pending = new Map<string, PendingJob>();
  private readonly seenKeys = new Set<string>();
  private closed = false;

  async enqueue<T>(input: {
    name: string;
    payload: T;
    delayMs?: number | undefined;
    idempotencyKey?: string | undefined;
    maxAttempts?: number | undefined;
  }): Promise<{ jobId: string }> {
    if (this.closed) throw new Error('Queue is closed');

    if (input.idempotencyKey) {
      if (this.seenKeys.has(input.idempotencyKey)) {
        return { jobId: `deduped_${input.idempotencyKey}` };
      }
      this.seenKeys.add(input.idempotencyKey);
    }

    const job: PendingJob = {
      id: randomUUID(),
      name: input.name,
      payload: input.payload,
      attempt: 1,
      maxAttempts: input.maxAttempts ?? 3,
      runAt: Date.now() + (input.delayMs ?? 0),
    };

    this.pending.set(job.id, job);
    this.schedule(job, input.delayMs ?? 0);
    return { jobId: job.id };
  }

  process<T>(name: string, handler: (job: QueueJob<T>) => Promise<void>): void {
    this.handlers.set(name, handler as (job: QueueJob<never>) => Promise<void>);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.pending.values()) {
      if (job.timer) clearTimeout(job.timer);
    }
    this.pending.clear();
  }

  private schedule(job: PendingJob, delayMs: number): void {
    job.timer = setTimeout(() => {
      void this.run(job);
    }, Math.max(0, delayMs));
    // Do not hold the event loop open for a delayed job.
    job.timer.unref?.();
  }

  private async run(job: PendingJob): Promise<void> {
    if (this.closed) return;
    const handler = this.handlers.get(job.name);
    if (!handler) {
      console.error(`  [queue] no handler registered for "${job.name}"`);
      this.pending.delete(job.id);
      return;
    }

    try {
      await handler({
        id: job.id,
        name: job.name,
        payload: job.payload as never,
        attempt: job.attempt,
      });
      this.pending.delete(job.id);
    } catch (error) {
      if (job.attempt >= job.maxAttempts) {
        // Dead-letter: log loudly and stop. Retrying forever hides the failure.
        console.error(
          `  [queue] job "${job.name}" failed permanently after ${job.attempt} attempts:`,
          error,
        );
        this.pending.delete(job.id);
        return;
      }
      job.attempt += 1;
      // Exponential backoff, capped so a retry storm cannot form.
      this.schedule(job, Math.min(30_000, 2 ** job.attempt * 250));
    }
  }
}
