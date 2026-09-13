/**
 * The customer's cart, shared across the storefront, product and cart screens.
 *
 * In memory for this checkpoint. Persisting it across launches — and
 * reconciling it with the server's basket — arrives with checkout, where the
 * quote endpoint is wired; until then a cart that survived a restart would
 * outlive the staging prices it was built against.
 */

import { createContext, useContext, useMemo, useReducer, type ReactNode } from 'react';

import { EMPTY_CART, cartReducer, itemCount, refusalFor, type CartAction, type CartRefusal, type CartState } from './cart';

interface CartValue {
  cart: CartState;
  count: number;
  dispatch: (action: CartAction) => void;
  refusalFor: (merchantSlug: string) => CartRefusal;
}

const CartContext = createContext<CartValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [cart, dispatch] = useReducer(cartReducer, EMPTY_CART);
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
