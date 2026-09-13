/**
 * The cart, as a reducer.
 *
 * It holds what the customer chose — a product, a quantity, the options — and
 * nothing that costs money. Prices, fees and totals come from a quote, because
 * a client that adds up its own total has decided what someone pays, and that
 * decision belongs to the server. The web basket learned the same rule.
 *
 * One merchant per cart. A DASH order has one vendor and one branch — the
 * domain requires it — so a cart that mixed two shops would describe an order
 * that cannot exist. Adding from a second merchant is refused with a reason
 * the screen can put to the customer, rather than silently replacing their
 * cart or silently mixing it.
 *
 * Pure: tested directly.
 */

export const MAX_LINE_QUANTITY = 20;

export interface CartLine {
  /** Stable identity: the product plus its chosen options. */
  key: string;
  productId: string;
  quantity: number;
  /** option group id → option id */
  options: Readonly<Record<string, string>>;
}

export interface CartState {
  merchantSlug: string | null;
  lines: readonly CartLine[];
}

export const EMPTY_CART: CartState = { merchantSlug: null, lines: [] };

export type CartAction =
  | { type: 'add'; merchantSlug: string; productId: string; quantity: number; options?: Record<string, string> }
  | { type: 'setQuantity'; key: string; quantity: number }
  | { type: 'remove'; key: string }
  | { type: 'replaceWith'; merchantSlug: string; productId: string; quantity: number; options?: Record<string, string> }
  | { type: 'clear' };

/** Why an add was refused, when it was. */
export type CartRefusal = 'different_merchant' | null;

/** The same product with the same options is one line, whatever order the options arrived in. */
export function lineKey(productId: string, options: Readonly<Record<string, string>> = {}): string {
  const parts = Object.keys(options)
    .sort()
    .map((group) => `${group}=${options[group]}`);
  return [productId, ...parts].join('|');
}

const clampQuantity = (n: number): number => Math.max(1, Math.min(MAX_LINE_QUANTITY, Math.trunc(n)));

/** Would this add be refused? Asked before dispatching, so the screen can explain. */
export function refusalFor(state: CartState, merchantSlug: string): CartRefusal {
  return state.merchantSlug && state.merchantSlug !== merchantSlug && state.lines.length > 0
    ? 'different_merchant'
    : null;
}

export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case 'add': {
      if (!Number.isFinite(action.quantity) || action.quantity < 1) return state;
      if (refusalFor(state, action.merchantSlug)) return state;
      const options = action.options ?? {};
      const key = lineKey(action.productId, options);
      const existing = state.lines.find((line) => line.key === key);
      const lines = existing
        ? state.lines.map((line) => (line.key === key ? { ...line, quantity: clampQuantity(line.quantity + action.quantity) } : line))
        : [...state.lines, { key, productId: action.productId, quantity: clampQuantity(action.quantity), options }];
      return { merchantSlug: action.merchantSlug, lines };
    }
    case 'replaceWith':
      return cartReducer(EMPTY_CART, { ...action, type: 'add' });
    case 'setQuantity': {
      if (!Number.isFinite(action.quantity)) return state;
      if (action.quantity < 1) return cartReducer(state, { type: 'remove', key: action.key });
      return { ...state, lines: state.lines.map((line) => (line.key === action.key ? { ...line, quantity: clampQuantity(action.quantity) } : line)) };
    }
    case 'remove': {
      const lines = state.lines.filter((line) => line.key !== action.key);
      return lines.length === 0 ? EMPTY_CART : { ...state, lines };
    }
    case 'clear':
      return EMPTY_CART;
  }
}

export function itemCount(state: CartState): number {
  return state.lines.reduce((total, line) => total + line.quantity, 0);
}
