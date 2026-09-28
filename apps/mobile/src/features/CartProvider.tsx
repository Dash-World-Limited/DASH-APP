/**
 * The customer's cart, shared across the storefront, product and cart screens.
 *
 * Kept on the phone across launches, so closing the app — or Android closing
 * it — does not lose what someone chose. Only choices are stored: product ids,
 * quantities and options, never a price. Prices come from the server's quote
 * at checkout, so a cart restored days later is re-priced, and a product the
 * shop has since removed is flagged on the cart screen rather than ordered.
 *
 * A stored cart that does not parse is discarded, never repaired.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';

import { EMPTY_CART, cartReducer, itemCount, parseStoredCart, refusalFor, type CartAction, type CartRefusal, type CartState } from './cart';

const STORAGE_KEY = 'dash.cart.v1';

interface CartValue {
  cart: CartState;
  count: number;
  dispatch: (action: CartAction) => void;
  refusalFor: (merchantSlug: string) => CartRefusal;
}

const CartContext = createContext<CartValue | null>(null);

type Internal = CartAction | { type: 'restore'; state: CartState };

function reducer(state: CartState, action: Internal): CartState {
  // A restore only ever fills an empty cart: something added before the
  // stored cart finished loading is kept, not overwritten.
  if (action.type === 'restore') return state.lines.length === 0 ? action.state : state;
  return cartReducer(state, action);
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [cart, dispatch] = useReducer(reducer, EMPTY_CART);
  const restored = useRef(false);

  useEffect(() => {
    let live = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        const stored = parseStoredCart(raw);
        if (live && stored) dispatch({ type: 'restore', state: stored });
      })
      .catch(() => undefined)
      .finally(() => {
        restored.current = true;
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    // Nothing is written until the stored cart has been read, so an empty
    // first render can never overwrite it.
    if (!restored.current) return;
    const write = cart.lines.length === 0 ? AsyncStorage.removeItem(STORAGE_KEY) : AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cart));
    void write.catch(() => undefined);
  }, [cart]);

  const value = useMemo<CartValue>(
    () => ({ cart, count: itemCount(cart), dispatch, refusalFor: (slug) => refusalFor(cart, slug) }),
    [cart],
  );
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartValue {
  const value = useContext(CartContext);
  if (!value) throw new Error('useCart must be used inside <CartProvider>.');
  return value;
}
