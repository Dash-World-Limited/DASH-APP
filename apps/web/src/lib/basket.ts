'use client';

/**
 * The basket.
 *
 * Held in `localStorage` so a customer does not lose a half-built order to a
 * refresh. It stores **only** item ids, quantities, and modifier ids — never a
 * price. Prices come from `/v1/orders/quote` on every change, so a stale or
 * tampered basket cannot affect what anyone is charged.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'dash.basket.v1';

export interface BasketLine {
  itemId: string;
  quantity: number;
  modifierIds: string[];
  /** Display-only, so the basket can render without re-fetching the menu. */
  name: string;
  unitPriceHint: number;
  modifierNames: string[];
  instructions?: string;
}

export interface Basket {
  vendorSlug: string | null;
  vendorName: string | null;
  branchId: string | null;
  lines: BasketLine[];
}

const EMPTY: Basket = { vendorSlug: null, vendorName: null, branchId: null, lines: [] };

let basket: Basket = EMPTY;
let hydrated = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function persist(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(basket));
  } catch {
    // Storage full or blocked. The in-memory basket still works for this visit.
  }
}

function hydrate(): void {
  if (hydrated || typeof window === 'undefined') return;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Basket;
    // Validate rather than trusting whatever is in storage — it may be from an
    // older version of the app, or hand-edited.
    if (parsed && Array.isArray(parsed.lines)) {
      basket = {
        vendorSlug: typeof parsed.vendorSlug === 'string' ? parsed.vendorSlug : null,
        vendorName: typeof parsed.vendorName === 'string' ? parsed.vendorName : null,
        branchId: typeof parsed.branchId === 'string' ? parsed.branchId : null,
        lines: parsed.lines.filter(
          (line): line is BasketLine =>
            typeof line?.itemId === 'string' &&
            Number.isInteger(line?.quantity) &&
            line.quantity > 0,
        ),
      };
    }
  } catch {
    basket = EMPTY;
  }
}

function subscribe(listener: () => void): () => void {
  hydrate();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = (): Basket => {
  hydrate();
  return basket;
};

// The server render has no storage, so it always sees an empty basket. Returning
// a stable reference here avoids a hydration mismatch warning.
const getServerSnapshot = (): Basket => EMPTY;

function setBasket(next: Basket): void {
  basket = next;
  persist();
  emit();
}

/** A stable key for one configuration of an item — same item, same modifiers. */
function lineKey(itemId: string, modifierIds: readonly string[]): string {
  return `${itemId}::${[...modifierIds].sort().join(',')}`;
}

export function useBasket() {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const addLine = useCallback(
    (input: {
      vendorSlug: string;
      vendorName: string;
      branchId: string;
      line: BasketLine;
    }): { switchedVendor: boolean } => {
      // One vendor per basket. Mixing them cannot be fulfilled as a single
      // delivery, so switching clears rather than silently failing at checkout.
      const switchedVendor =
        basket.vendorSlug !== null && basket.vendorSlug !== input.vendorSlug;

      const lines = switchedVendor ? [] : [...basket.lines];
      const key = lineKey(input.line.itemId, input.line.modifierIds);
      const existing = lines.findIndex(
        (line) => lineKey(line.itemId, line.modifierIds) === key,
      );

      if (existing >= 0) {
        const found = lines[existing];
        if (found) {
          lines[existing] = { ...found, quantity: found.quantity + input.line.quantity };
        }
      } else {
        lines.push(input.line);
      }

      setBasket({
        vendorSlug: input.vendorSlug,
        vendorName: input.vendorName,
        branchId: input.branchId,
        lines,
      });
      return { switchedVendor };
    },
    [],
  );

  const setQuantity = useCallback((index: number, quantity: number) => {
    const lines = [...basket.lines];
    const line = lines[index];
    if (!line) return;

    if (quantity <= 0) lines.splice(index, 1);
    else lines[index] = { ...line, quantity: Math.min(quantity, 50) };

    setBasket(
      lines.length === 0 ? EMPTY : { ...basket, lines },
    );
  }, []);

  const clear = useCallback(() => setBasket(EMPTY), []);

  const itemCount = current.lines.reduce((total, line) => total + line.quantity, 0);

  /** Indicative only — the server's quote is authoritative. */
  const estimatedSubtotal = current.lines.reduce(
    (total, line) => total + line.unitPriceHint * line.quantity,
    0,
  );

  return { basket: current, addLine, setQuantity, clear, itemCount, estimatedSubtotal };
}

/** The shape the API expects. Note: no prices. */
export function toQuoteItems(basket: Basket) {
  return basket.lines.map((line) => ({
    itemId: line.itemId,
    quantity: line.quantity,
    modifierIds: line.modifierIds,
    ...(line.instructions ? { instructions: line.instructions } : {}),
  }));
}

/** Clear the basket after a successful checkout, from outside a component. */
export function clearBasketAfterCheckout(): void {
  setBasket(EMPTY);
}

export function useBasketCount(): number {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return current.lines.reduce((total, line) => total + line.quantity, 0);
}

/**
 * True once the client has read storage.
 *
 * The server render always sees an empty basket, so a component that renders
 * "your basket is empty" immediately would flash that message before hydration
 * even when the basket has items. Gate on this instead.
 */
export function useBasketHydrated(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready;
}
