/**
 * What the phone must remember about an order the server will not repeat.
 *
 * The delivery PIN is returned once, at checkout, and is what the customer
 * reads to the rider at the door. If the app is closed while Paystack's page
 * is open, the customer must still have it when they come back — so it is
 * kept in the platform's secure store, keyed by order, and nowhere else.
 *
 * The Paystack checkout link is kept alongside it so an interrupted payment
 * can be resumed from the order screen without starting a second checkout.
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export interface RememberedOrder {
  deliveryPin?: string;
  authorizationUrl?: string | null;
}

/** SecureStore keys allow only [A-Za-z0-9._-]. Order ids are cuids, but be strict. */
const keyFor = (orderId: string): string => `dash.order.${orderId.replace(/[^A-Za-z0-9._-]/g, '_')}`;

async function read(key: string): Promise<string | null> {
  try {
    if (Platform.OS === 'web') return globalThis.localStorage?.getItem(key) ?? null;
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function write(key: string, value: string): Promise<void> {
  try {
    if (Platform.OS === 'web') globalThis.localStorage?.setItem(key, value);
    else await SecureStore.setItemAsync(key, value);
  } catch {
    // Storage refused. The order itself is safe on the server; only the
    // convenience of resuming is lost.
  }
}

export async function rememberOrder(orderId: string, update: RememberedOrder): Promise<void> {
  const current = await recallOrder(orderId);
  await write(keyFor(orderId), JSON.stringify({ ...current, ...update }));
}

export async function recallOrder(orderId: string): Promise<RememberedOrder> {
  const raw = await read(keyFor(orderId));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as RememberedOrder;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
