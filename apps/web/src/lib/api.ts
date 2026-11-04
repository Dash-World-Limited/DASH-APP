import type { MerchantServiceCategoryId } from '@dash/domain/services';

/**
 * API client.
 *
 * A thin typed wrapper over `fetch`. Two things it deliberately does NOT do:
 *
 *   1. It never sends a price, a role, or a permission. Those are the server's
 *      to decide; sending them would be theatre at best and a vulnerability at
 *      worst if the server ever started trusting them.
 *   2. It never stores tokens in `localStorage` — see `session.ts` for why.
 */

export const API_BASE =
  process.env['NEXT_PUBLIC_API_URL'] ?? 'http://127.0.0.1:4000';

/**
 * The CSRF cookie name, mirrored from the API.
 *
 * Readable by script by design — the double-submit scheme needs the client to
 * echo it back in a header. It authorises nothing on its own; it only proves
 * the request came from script on our own origin, which is exactly what a
 * cross-site attacker cannot do.
 */
export const CSRF_COOKIE = 'dash_csrf';
export const CSRF_HEADER = 'X-CSRF-Token';

function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const entry = document.cookie
    .split('; ')
    .find((candidate) => candidate.startsWith(`${CSRF_COOKIE}=`));
  return entry ? decodeURIComponent(entry.slice(CSRF_COOKIE.length + 1)) : null;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: { field: string; message: string }[];
  };
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: { field: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** True when signing in again would fix it. */
  get isAuthFailure(): boolean {
    return this.status === 401;
  }

  get needsStepUp(): boolean {
    return this.code === 'step_up_required';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  token?: string | null;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  // Echo the CSRF token on anything that can change state. The API only demands
  // it when the request actually carries the refresh cookie, but sending it
  // unconditionally is simpler and costs nothing.
  if (method !== 'GET') {
    const csrfToken = readCsrfToken();
    if (csrfToken) headers[CSRF_HEADER] = csrfToken;
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      // Required for the browser to send and store the auth cookies at all: the
      // web app and the API are different origins during development, and
      // cross-origin fetch omits cookies unless asked.
      credentials: 'include',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    // A network failure is not a server error, and telling the user to "try
    // again" is more useful than showing them a stack trace.
    throw new ApiRequestError(
      0,
      'network_error',
      'Could not reach DASH APP. Check your connection and try again.',
    );
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiRequestError(response.status, 'bad_response', 'Received an unexpected response.');
  }

  if (!response.ok) {
    const body = payload as Partial<ApiErrorBody>;
    throw new ApiRequestError(
      response.status,
      body.error?.code ?? 'unknown',
      body.error?.message ?? 'Something went wrong.',
      body.error?.requestId,
      body.error?.details,
    );
  }

  return payload as T;
}

/** Generate an idempotency key for a single checkout attempt. */
export function newIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `key-${Date.now()}-${Math.random()}`;
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface Money {
  readonly amount: number;
}

export interface QuoteLine {
  kind: string;
  label: string;
  amount: number;
  explanation: string;
}

export interface Quote {
  ruleVersion: string;
  currency: 'NGN';
  lines: QuoteLine[];
  itemsSubtotal: number;
  discountTotal: number;
  deliveryFee: number;
  serviceFee: number;
  smallOrderFee: number;
  surgeAmount: number;
  tax: number;
  tip: number;
  walletCreditApplied: number;
  total: number;
}

export interface VendorSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  /** Deprecated storage value retained for old clients. */
  category: string;
  serviceCategory: MerchantServiceCategoryId | null;
  rating: { average: number; count: number };
  branch: {
    id: string;
    state: string;
    minimumOrder: number;
    supportsDelivery: boolean;
    supportsPickup: boolean;
    estimatedMinutes: number;
  } | null;
  distanceMetres: number | null;
}

export interface Modifier {
  id: string;
  name: string;
  priceDelta: number;
}

export interface ModifierGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: Modifier[];
}

export interface MenuItem {
  id: string;
  name: string;
  description: string | null;
  price: number;
  imageKey: string | null;
  prepMinutes: number;
  isAvailable: boolean;
  requiresAgeCheck: boolean;
  allergens: string | null;
  modifierGroups: ModifierGroup[];
}

export interface VendorDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  /** Deprecated storage value retained for old clients. */
  category: string;
  serviceCategory: MerchantServiceCategoryId | null;
  ratingAverage: number;
  ratingCount: number;
  branches: {
    id: string;
    name: string;
    address: string;
    latitude: number;
    longitude: number;
    state: string;
    minimumOrder: number;
    defaultPrepMinutes: number;
    busyExtraMinutes: number;
    supportsDelivery: boolean;
    supportsPickup: boolean;
  }[];
  categories: {
    id: string;
    name: string;
    description: string | null;
    items: MenuItem[];
  }[];
}

export interface Address {
  id: string;
  label: string | null;
  line1: string;
  landmark: string | null;
  instructions: string | null;
  contactPhone: string;
  latitude: number;
  longitude: number;
  isDefault: boolean;
}

export interface OrderSummary {
  id: string;
  code: string;
  status: string;
  statusLabel: string;
  phase: 'confirming' | 'preparing' | 'on_the_way' | 'complete' | 'stopped';
  total: number;
  createdAt: string;
  deliveredAt: string | null;
  vendor: { id: string; name: string; slug: string };
  items: { nameSnapshot: string; quantity: number }[];
}

/**
 * What a successful sign-in returns.
 *
 * Note what is absent: there is no `refreshToken`. It is set as a HttpOnly
 * cookie the browser stores and this code can never read. If a refresh token
 * ever appears in this type again, the cookie has become decoration.
 */
export interface Session {
  accessToken: string;
  expiresIn: number;
  csrfToken: string;
}

export interface Me {
  identity: {
    id: string;
    phone: string | null;
    email: string | null;
    displayName: string | null;
  };
  roles: string[];
  permissions: string[];
  vendorId: string | null;
  riderId: string | null;
  customerId: string | null;
}
