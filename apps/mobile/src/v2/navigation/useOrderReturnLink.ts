import { useEffect, useRef } from 'react';
import { Linking, Platform } from 'react-native';

import { selectTab, type NavigationState } from './model';

function isOrderReturnLink(url: string): boolean {
  // RN's installed URL.hostname polyfill parses HTTP(S) authorities only.
  // Match this single existing custom-scheme contract without that polyfill.
  return url.trim() === url && /^dash:\/\/orders\/?(?:\?[^\s#]*)?$/.test(url);
}

/** Existing /pay/complete contract. A URL never proves payment or names an order. */
export function orderReturnNavigation(url: string, current: NavigationState): NavigationState | null {
  if (!isOrderReturnLink(url)) return null;
  // A Rider's delivery may still be restoring on cold start. Never switch
  // their face based on a Customer payment callback.
  if (current.face === 'rider') return null;
  // Ignore all query parameters, including forged payment status/reference.
  // The signed-in Orders screen loads only this customer's server-owned data.
  if (current.stack.length === 1 && current.stack[0]?.name === 'customer.orders') return current;
  return selectTab(current, { name: 'customer.orders' });
}

/** Mount above startup/authentication gates; defer navigation until authenticated. */
export function useOrderReturnLink(onOpen: (url: string) => void): void {
  const open = useRef(onOpen);
  open.current = onOpen;
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let live = true;
    let receivedEvent = false;
    const subscription = Linking.addEventListener('url', ({ url }) => {
      if (!isOrderReturnLink(url)) return;
      receivedEvent = true;
      open.current(url);
    });
    void Linking.getInitialURL().then((url) => {
      if (live && !receivedEvent && url && isOrderReturnLink(url)) open.current(url);
    }, () => undefined);
    return () => { live = false; subscription.remove(); };
  }, []);
}
