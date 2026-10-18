import { useEffect, useRef } from 'react';
import { Linking, Platform } from 'react-native';

import { selectTab, type NavigationState } from './model';

/** Existing /pay/complete contract. A URL never proves payment or names an order. */
export function orderReturnNavigation(url: string, current: NavigationState): NavigationState | null {
  try {
    const link = new URL(url);
    if (link.protocol !== 'dash:' || link.hostname !== 'orders' || link.username || link.password || link.port ||
      (link.pathname !== '' && link.pathname !== '/') || link.hash) return null;
  } catch {
    return null;
  }
  // A Rider's delivery may still be restoring on cold start. Never switch
  // their face based on a Customer payment callback.
  if (current.face === 'rider') return null;
  // Ignore all query parameters, including forged payment status/reference.
  // The signed-in Orders screen loads only this customer's server-owned data.
  return selectTab(current, { name: 'customer.orders' });
}

/** Mount inside authenticated navigation, after /me confirms the account. */
export function useOrderReturnLink(onOpen: (url: string) => void): void {
  const open = useRef(onOpen);
  open.current = onOpen;
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let live = true;
    let receivedEvent = false;
    const subscription = Linking.addEventListener('url', ({ url }) => {
      receivedEvent = true;
      open.current(url);
    });
    void Linking.getInitialURL().then((url) => {
      if (live && !receivedEvent && url) open.current(url);
    }, () => undefined);
    return () => { live = false; subscription.remove(); };
  }, []);
}
