/**
 * Ordering: addresses, the server's quote, checkout, payment, and history.
 *
 * The app's part in money is small on purpose. It sends what the customer
 * chose — items, quantities, options, an address — and shows what the server
 * answers. It never sends a price, never adds up a total, and never decides
 * that a payment succeeded: after Paystack's checkout it asks the server,
 * which asks Paystack.
 *
 * The pure helpers are tested directly; the fetchers take the client as an
 * argument so they are tested against a fake one.
 */

import type { Kobo } from '@dash/domain/money';

import type { ApiClient } from '../api/client';
import type { CartState } from '../features/cart';

// ---------------------------------------------------------------- shapes

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

export interface NewAddress {
  label?: string;
  line1: string;
  landmark?: string;
  instructions?: string;
  contactPhone: string;
  latitude: number;
  longitude: number;
  isDefault?: boolean;
}

export interface Quote {
  itemsSubtotal: Kobo;
  discountTotal: Kobo;
  deliveryFee: Kobo;
  serviceFee: Kobo;
  smallOrderFee: Kobo;
  surgeAmount: Kobo;
  tax: Kobo;
  tip: Kobo;
  total: Kobo;
}

export interface QuoteResult {
  quote: Quote;
  estimatedPrepMinutes: number;
  estimatedDeliveryMinutes: number;
}

export interface PlacedOrder {
  order: { id: string; code: string; total: Kobo };
  payment: { status: string; authorizationUrl: string | null };
  /** Shown once, to read to the rider at the door. */
  deliveryPin: string;
}

export type PaymentOutcome =
  | 'captured'
  | 'pending'
  | 'failed'
  | 'refunded'
  | 'amount_mismatch'
  | 'captured_for_closed_order'
  | 'order_closed'
  | 'unknown_payment';

export interface VerifyResult {
  payment: { outcome: PaymentOutcome };
  order: { id: string; status: string };
}

export interface OrderSummary {
  id: string;
  code: string;
  status: string;
  statusLabel: string;
  phase: string;
  total: Kobo;
  createdAt: string;
  deliveredAt: string | null;
  vendor: { id: string; name: string; slug: string; category: string };
  items: { nameSnapshot: string; quantity: number }[];
}

export interface OrderDetail {
  id: string;
  code: string;
  status: string;
  statusLabel: string;
  phase: string;
  total: Kobo;
  itemsSubtotal: Kobo;
  discountTotal: Kobo;
  deliveryFee: Kobo;
  serviceFee: Kobo;
  smallOrderFee: Kobo;
  surgeAmount: Kobo;
  tax: Kobo;
  tip: Kobo;
  createdAt: string;
  placedAt: string | null;
  deliveredAt: string | null;
  estimatedDeliveryAt: string | null;
  cancellationReason: string | null;
  vendor: { name: string; slug: string };
  address: { line1: string; landmark: string | null } | null;
  items: { nameSnapshot: string; quantity: number; lineTotal: Kobo }[];
  statusEvents: { toStatus: string; createdAt: string }[];
  rider: OrderRider | null;
  /**
   * Refunds owed on this order, worded by the server. "Refunded" appears only
   * once Paystack has confirmed the refund. Optional: older servers omit it.
   */
  refunds?: { amount: Kobo; status: string; label: string; body: string; refundedAt: string | null; createdAt: string }[];
  /** Rating the rider who delivered it. Optional: older servers omit it. */
  riderRating?: RiderRatingState | null;
}

/** The rider on an order, as the customer sees them. */
export interface OrderRider {
  name: string | null;
  vehicleType: string;
  latitude: number | null;
  longitude: number | null;
  reportedAt: string | null;
  isStale: boolean;
  /**
   * The assigned rider's number, sent only while they are working this order.
   * Optional: older servers never send it.
   */
  phone?: string | null;
}

export interface RiderRating {
  rating: number;
  comment: string | null;
  createdAt: string;
}

/** Present once a rider has delivered the order. */
export interface RiderRatingState {
  riderName: string | null;
  canRate: boolean;
  /** What the customer gave, once they have. */
  rating: RiderRating | null;
}

/** How a refund's state reads at a glance. Only a confirmed refund is green. */
export function refundTone(status: string): 'success' | 'danger' | 'accent' {
  if (status === 'refunded') return 'success';
  if (status === 'refund_failed') return 'danger';
  return 'accent';
}

export interface OrderDetailResult {
  order: OrderDetail;
  cancellation: { allowed: boolean; explanation: string };
}

// ---------------------------------------------------------------- pure helpers

/**
 * The cart as the server's basket. Option ids are the server's modifier ids;
 * the "None" choice of an optional group is the empty string and is dropped.
 */
export function basketFromCart(cart: CartState): { itemId: string; quantity: number; modifierIds: string[] }[] {
  return cart.lines.map((line) => ({
    itemId: line.productId,
    quantity: line.quantity,
    modifierIds: Object.values(line.options).filter((id) => id !== ''),
  }));
}

/**
 * A fresh idempotency key for one checkout attempt. Uniqueness is all it
 * needs — it is not a secret — so time plus randomness is enough.
 */
export function newIdempotencyKey(): string {
  return `app-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** The receipt's rows: every charge the server applied, and nothing it did not. */
export function quoteRows(quote: Quote): { label: string; amount: Kobo; negative?: boolean }[] {
  const rows: { label: string; amount: Kobo; negative?: boolean }[] = [{ label: 'Items', amount: quote.itemsSubtotal }];
  if (quote.discountTotal > 0) rows.push({ label: 'Discount', amount: quote.discountTotal, negative: true });
  rows.push({ label: 'Delivery fee', amount: quote.deliveryFee });
  if (quote.serviceFee > 0) rows.push({ label: 'Service fee', amount: quote.serviceFee });
  if (quote.smallOrderFee > 0) rows.push({ label: 'Small order fee', amount: quote.smallOrderFee });
  if (quote.surgeAmount > 0) rows.push({ label: 'Busy-period fee', amount: quote.surgeAmount });
  if (quote.tax > 0) rows.push({ label: 'Tax', amount: quote.tax });
  if (quote.tip > 0) rows.push({ label: 'Rider tip', amount: quote.tip });
  return rows;
}

/**
 * What the customer is told after the server has asked Paystack.
 *
 * Only `captured` is success. Everything else says plainly what happened and
 * what to do, and nothing claims a payment went through that the server has
 * not confirmed.
 */
export function describeOutcome(outcome: PaymentOutcome): { title: string; body: string; tone: 'success' | 'waiting' | 'problem'; canRetry: boolean } {
  switch (outcome) {
    case 'captured':
      return { title: 'Payment confirmed', body: 'Your order has gone to the shop.', tone: 'success', canRetry: false };
    case 'pending':
      return {
        title: 'Payment not finished',
        body: 'Paystack has not confirmed a payment yet. If you completed it, it can take a moment — check again. If you closed the page, pay again.',
        tone: 'waiting',
        canRetry: true,
      };
    case 'failed':
      return { title: 'Payment did not go through', body: 'Nothing was taken. You can try again, with the same card or another.', tone: 'problem', canRetry: true };
    case 'refunded':
      return { title: 'Payment refunded', body: 'This payment was returned to you.', tone: 'problem', canRetry: false };
    case 'amount_mismatch':
    case 'captured_for_closed_order':
      return {
        title: 'We need to check this payment',
        body: 'Something about this payment needs a person to look at it. Your money is safe — contact support with your order code.',
        tone: 'problem',
        canRetry: false,
      };
    case 'order_closed':
      return {
        title: 'This order was cancelled',
        body: 'Any refund it is owed has been recorded. Do not pay again.',
        tone: 'problem',
        canRetry: false,
      };
    case 'unknown_payment':
      return { title: 'No payment found', body: 'We could not find a payment for this order. Try paying again.', tone: 'problem', canRetry: true };
  }
}

/** Orders still moving, for the Orders tab's "Active" section. */
export function isActiveOrder(status: string): boolean {
  return !['draft', 'delivered', 'cancelled', 'rejected', 'refunded'].includes(status);
}

// ---------------------------------------------------------------- fetchers

export async function listAddresses(api: ApiClient): Promise<Address[]> {
  return (await api.request<{ addresses: Address[] }>('/v1/addresses')).addresses;
}

export async function createAddress(api: ApiClient, address: NewAddress): Promise<{ id: string }> {
  return (await api.request<{ address: { id: string } }>('/v1/addresses', { method: 'POST', body: address })).address;
}

/**
 * The words of a saved address, or making it the default. Its position is not
 * editable: the delivery fee is quoted from where it was saved.
 */
export interface AddressEdit {
  label?: string;
  line1?: string;
  landmark?: string;
  instructions?: string;
  contactPhone?: string;
  isDefault?: true;
}

export async function updateAddress(api: ApiClient, id: string, edit: AddressEdit): Promise<void> {
  await api.request(`/v1/addresses/${encodeURIComponent(id)}`, { method: 'PATCH', body: edit });
}

/**
 * Rates the rider who delivered this order. The server decides which rider
 * that is; the app only sends the stars and an optional comment.
 */
export async function rateRider(api: ApiClient, orderId: string, input: { rating: number; comment?: string }): Promise<RiderRating> {
  const body: { rating: number; comment?: string } = { rating: input.rating };
  const comment = input.comment?.trim();
  if (comment) body.comment = comment;
  return (
    await api.request<{ rating: RiderRating }>(`/v1/orders/${encodeURIComponent(orderId)}/rider-rating`, { method: 'POST', body })
  ).rating;
}

/** Removes it from the saved list. Past orders keep the address they went to. */
export async function removeAddress(api: ApiClient, id: string): Promise<void> {
  await api.request(`/v1/addresses/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function requestQuote(api: ApiClient, input: { branchId: string; cart: CartState; addressId: string }): Promise<QuoteResult> {
  return api.request<QuoteResult>('/v1/orders/quote', {
    method: 'POST',
    body: { branchId: input.branchId, items: basketFromCart(input.cart), mode: 'delivery', addressId: input.addressId },
  });
}

export function placeOrder(
  api: ApiClient,
  input: { branchId: string; cart: CartState; addressId: string; instructions?: string; idempotencyKey: string },
): Promise<PlacedOrder> {
  return api.request<PlacedOrder>('/v1/orders', {
    method: 'POST',
    headers: { 'Idempotency-Key': input.idempotencyKey },
    body: {
      branchId: input.branchId,
      items: basketFromCart(input.cart),
      mode: 'delivery',
      addressId: input.addressId,
      paymentMethod: 'card',
      ...(input.instructions ? { instructions: input.instructions } : {}),
    },
  });
}

export function verifyPayment(api: ApiClient, orderId: string): Promise<VerifyResult> {
  return api.request<VerifyResult>(`/v1/orders/${encodeURIComponent(orderId)}/payment/verify`, { method: 'POST' });
}

export function retryPayment(api: ApiClient, orderId: string): Promise<{ payment: { status: string; authorizationUrl: string | null } }> {
  return api.request(`/v1/orders/${encodeURIComponent(orderId)}/payment/retry`, { method: 'POST' });
}

export async function listOrders(api: ApiClient, status: 'active' | 'past' | 'all' = 'all'): Promise<OrderSummary[]> {
  return (await api.request<{ orders: OrderSummary[] }>(`/v1/orders?status=${status}&limit=30`)).orders;
}

export function getOrder(api: ApiClient, orderId: string): Promise<OrderDetailResult> {
  return api.request<OrderDetailResult>(`/v1/orders/${encodeURIComponent(orderId)}`);
}

export interface CancelResult {
  cancelled: boolean;
  /**
   * `refund_pending_manual_review` when money is owed back (never "refunded"
   * — that is only ever said once Paystack confirms), or `no_payment_taken`.
   */
  refund?: { status: 'refund_pending_manual_review' | 'no_payment_taken'; amount: Kobo; label: string; explanation: string };
}

export function cancelOrder(api: ApiClient, orderId: string, reason?: string): Promise<CancelResult> {
  return api.request(`/v1/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST', body: reason ? { reason } : {} });
}
