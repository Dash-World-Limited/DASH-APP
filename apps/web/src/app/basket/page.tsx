'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AppHeader } from '@/components/AppHeader';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  EstimateNote,
  Field,
  Input,
  LoadingBlock,
  formatNaira,
} from '@/components/ui';
import { ApiRequestError, newIdempotencyKey, type Address, type Quote } from '@/lib/api';
import { clearBasketAfterCheckout, toQuoteItems, useBasket, useBasketHydrated } from '@/lib/basket';
import { authedFetch, useHasSession } from '@/lib/session';

interface QuoteResponse {
  quote: Quote;
  estimatedPrepMinutes: number;
  estimatedDeliveryMinutes: number;
}

export default function BasketPage() {
  const router = useRouter();
  const hydrated = useBasketHydrated();
  const { basket, setQuantity, clear, itemCount } = useBasket();

  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [addressId, setAddressId] = useState<string | null>(null);
  const [mode, setMode] = useState<'delivery' | 'pickup'>('delivery');
  const [promoCode, setPromoCode] = useState('');
  const [appliedPromo, setAppliedPromo] = useState('');
  const [tipNaira, setTipNaira] = useState(0);

  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<ApiRequestError | null>(null);
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState<ApiRequestError | null>(null);

  const signedIn = useHasSession();

  // --- Load addresses -------------------------------------------------------
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await authedFetch<{ addresses: Address[] }>('/v1/addresses');
        if (cancelled) return;
        setAddresses(result.addresses);
        setAddressId(
          (current) => current ?? result.addresses.find((a) => a.isDefault)?.id ?? result.addresses[0]?.id ?? null,
        );
      } catch {
        if (!cancelled) setAddresses([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  // --- Re-quote whenever anything that affects the price changes -------------
  const requestQuote = useCallback(async (): Promise<void> => {
    if (basket.lines.length === 0 || !basket.branchId) {
      setQuote(null);
      return;
    }
    if (!signedIn) return;
    if (mode === 'delivery' && !addressId) return;

    setQuoting(true);
    setQuoteError(null);
    try {
      const result = await authedFetch<QuoteResponse>('/v1/orders/quote', {
        method: 'POST',
        body: {
          branchId: basket.branchId,
          items: toQuoteItems(basket),
          mode,
          ...(mode === 'delivery' && addressId ? { addressId } : {}),
          ...(appliedPromo ? { promoCode: appliedPromo } : {}),
          tip: tipNaira * 100,
        },
      });
      setQuote(result);
    } catch (caught) {
      const error =
        caught instanceof ApiRequestError
          ? caught
          : new ApiRequestError(0, 'unknown', 'Could not price your basket.');
      setQuoteError(error);
      setQuote(null);
      // A rejected promo should not stay stuck on the basket.
      if (error.code === 'unprocessable' && appliedPromo) setAppliedPromo('');
    } finally {
      setQuoting(false);
    }
  }, [basket, mode, addressId, appliedPromo, tipNaira, signedIn]);

  useEffect(() => {
    void requestQuote();
  }, [requestQuote]);

  // --- Checkout -------------------------------------------------------------
  const placeOrder = async (): Promise<void> => {
    if (!basket.branchId) return;
    setPlacing(true);
    setPlaceError(null);
    try {
      const result = await authedFetch<{
        order: { id: string; code: string; total: number };
        payment: { status: string; authorizationUrl: string | null };
        deliveryPin: string;
      }>('/v1/orders', {
        method: 'POST',
        // A fresh key per attempt. Reusing one across attempts would make a
        // retry after a genuine failure return the failed original.
        idempotencyKey: newIdempotencyKey(),
        body: {
          branchId: basket.branchId,
          items: toQuoteItems(basket),
          mode,
          ...(mode === 'delivery' && addressId ? { addressId } : {}),
          ...(appliedPromo ? { promoCode: appliedPromo } : {}),
          tip: tipNaira * 100,
          paymentMethod: 'card',
        },
      });

      clearBasketAfterCheckout();
      // The PIN is shown once on the tracking screen and never re-fetched.
      sessionStorage.setItem(`dash.pin.${result.order.id}`, result.deliveryPin);
      router.push(`/orders/${result.order.id}`);
    } catch (caught) {
      setPlaceError(
        caught instanceof ApiRequestError
          ? caught
          : new ApiRequestError(0, 'unknown', 'Could not place your order.'),
      );
    } finally {
      setPlacing(false);
    }
  };

  if (!hydrated) {
    return (
      <>
        <AppHeader />
        <main id="main" className="mx-auto max-w-3xl px-5 py-10">
          <LoadingBlock label="Loading your basket" />
        </main>
      </>
    );
  }

  if (itemCount === 0) {
    return (
      <>
        <AppHeader />
        <main id="main" className="mx-auto max-w-3xl px-5 py-10">
          <h1 className="mb-6 text-3xl font-extrabold tracking-tight">Your basket</h1>
          <EmptyState
            title="Your basket is empty"
            description="Find something you like and it will show up here."
            action={
              <Link href="/browse">
                <Button>Browse vendors</Button>
              </Link>
            }
          />
        </main>
      </>
    );
  }

  return (
    <>
      <AppHeader />
      <main id="main" className="mx-auto max-w-3xl px-5 py-10">
        <h1 className="text-3xl font-extrabold tracking-tight">Your basket</h1>
        <p className="mt-1.5 text-sm text-graphite-600">
          From <strong>{basket.vendorName}</strong>
        </p>

        {/* --- Lines --------------------------------------------------------- */}
        <ul className="mt-6 space-y-3">
          {basket.lines.map((line, index) => (
            <Card as="li" key={`${line.itemId}-${index}`} className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-semibold">{line.name}</p>
                  {line.modifierNames.length > 0 ? (
                    <p className="mt-0.5 text-sm text-graphite-600">
                      {line.modifierNames.join(', ')}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1 rounded-xl border">
                  <button
                    onClick={() => setQuantity(index, line.quantity - 1)}
                    aria-label={`Remove one ${line.name}`}
                    className="px-3 py-1.5 font-bold"
                  >
                    −
                  </button>
                  <span className="min-w-6 text-center text-sm font-semibold">
                    {line.quantity}
                  </span>
                  <button
                    onClick={() => setQuantity(index, line.quantity + 1)}
                    aria-label={`Add one ${line.name}`}
                    className="px-3 py-1.5 font-bold"
                  >
                    +
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </ul>

        <button onClick={clear} className="mt-3 text-sm text-graphite-600 underline">
          Empty basket
        </button>

        {!signedIn ? (
          <Card className="mt-8 p-6 text-center">
            <p className="font-semibold">Sign in to see your total</p>
            <p className="mt-1.5 text-sm text-graphite-600">
              Fees and delivery are calculated against your delivery address.
            </p>
            <Link href="/signin?next=/basket">
              <Button size="lg" className="mt-4">
                Sign in to continue
              </Button>
            </Link>
          </Card>
        ) : (
          <>
            {/* --- Fulfilment ---------------------------------------------- */}
            <section className="mt-8">
              <h2 className="text-lg font-bold">How would you like it?</h2>
              <div className="mt-3 flex gap-2">
                {(['delivery', 'pickup'] as const).map((option) => (
                  <button
                    key={option}
                    onClick={() => setMode(option)}
                    aria-pressed={mode === option}
                    className={`flex-1 rounded-xl border px-4 py-3 text-sm font-semibold capitalize transition-colors ${
                      mode === option
                        ? 'border-gold-400 bg-gold-50'
                        : 'hover:bg-[var(--surface-raised)]'
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </section>

            {mode === 'delivery' ? (
              <section className="mt-6">
                <h2 className="text-lg font-bold">Deliver to</h2>
                {addresses === null ? (
                  <div className="mt-3">
                    <LoadingBlock label="Loading addresses" />
                  </div>
                ) : addresses.length === 0 ? (
                  <EmptyState
                    title="No saved addresses"
                    description="Add a delivery address to continue. We check it is inside a service zone before saving it."
                  />
                ) : (
                  <ul className="mt-3 space-y-2">
                    {addresses.map((address) => (
                      <li key={address.id}>
                        <label
                          className={`flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${
                            addressId === address.id
                              ? 'border-gold-400 bg-gold-50'
                              : 'hover:bg-[var(--surface-raised)]'
                          }`}
                        >
                          <input
                            type="radio"
                            name="address"
                            checked={addressId === address.id}
                            onChange={() => setAddressId(address.id)}
                            className="mt-1 h-4 w-4"
                          />
                          <span>
                            {address.label ? (
                              <span className="block text-sm font-semibold">{address.label}</span>
                            ) : null}
                            <span className="block text-sm">{address.line1}</span>
                            {address.landmark ? (
                              <span className="block text-xs text-graphite-400">
                                Near {address.landmark}
                              </span>
                            ) : null}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ) : null}

            {/* --- Promo ---------------------------------------------------- */}
            <section className="mt-6">
              <Field label="Promo code" htmlFor="promo" hint="Try DASH10 or FREERIDE.">
                <div className="flex gap-2">
                  <Input
                    id="promo"
                    value={promoCode}
                    onChange={(event) => setPromoCode(event.target.value.toUpperCase())}
                    placeholder="Enter a code"
                    className="flex-1"
                  />
                  <Button
                    variant="ghost"
                    onClick={() => setAppliedPromo(promoCode.trim())}
                    disabled={promoCode.trim().length === 0}
                  >
                    Apply
                  </Button>
                </div>
              </Field>
              {appliedPromo ? (
                <p className="mt-2 text-sm text-emerald-600">
                  {appliedPromo} applied.{' '}
                  <button
                    className="underline"
                    onClick={() => {
                      setAppliedPromo('');
                      setPromoCode('');
                    }}
                  >
                    Remove
                  </button>
                </p>
              ) : null}
            </section>

            {/* --- Tip ------------------------------------------------------ */}
            <section className="mt-6">
              <h2 className="text-lg font-bold">Tip your rider</h2>
              <p className="mt-1 text-sm text-graphite-600">
                Riders keep 100% of tips. DASH APP takes nothing.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {[0, 200, 500, 1000].map((amount) => (
                  <button
                    key={amount}
                    onClick={() => setTipNaira(amount)}
                    aria-pressed={tipNaira === amount}
                    className={`rounded-xl border px-4 py-2 text-sm font-semibold transition-colors ${
                      tipNaira === amount
                        ? 'border-gold-400 bg-gold-50'
                        : 'hover:bg-[var(--surface-raised)]'
                    }`}
                  >
                    {amount === 0 ? 'No tip' : `₦${amount.toLocaleString('en-NG')}`}
                  </button>
                ))}
              </div>
            </section>

            {/* --- The quote ------------------------------------------------ */}
            <section className="mt-8">
              <h2 className="text-lg font-bold">Order total</h2>

              {quoteError ? (
                <div className="mt-3">
                  <ErrorState
                    title="Could not price this order"
                    message={quoteError.message}
                    requestId={quoteError.requestId}
                    onRetry={() => void requestQuote()}
                  />
                </div>
              ) : quote === null ? (
                <div className="mt-3">
                  {quoting ? (
                    <LoadingBlock label="Calculating your total" />
                  ) : (
                    <p className="text-sm text-graphite-600">
                      {mode === 'delivery' && !addressId
                        ? 'Choose a delivery address to see your total.'
                        : 'Preparing your total…'}
                    </p>
                  )}
                </div>
              ) : (
                <Card className={`mt-3 p-5 ${quoting ? 'opacity-60' : ''}`}>
                  <dl className="space-y-2.5">
                    {quote.quote.lines.map((line, index) => (
                      <div key={`${line.kind}-${index}`} className="flex items-baseline justify-between gap-4">
                        <dt className="text-sm">
                          {line.label}
                          <span className="block text-xs text-graphite-400">
                            {line.explanation}
                          </span>
                        </dt>
                        <dd
                          className={`shrink-0 text-sm font-semibold tabular-nums ${
                            line.amount < 0 ? 'text-emerald-600' : ''
                          }`}
                        >
                          {formatNaira(line.amount)}
                        </dd>
                      </div>
                    ))}
                  </dl>

                  <div className="mt-4 flex items-baseline justify-between border-t pt-4">
                    <span className="text-base font-bold">Total</span>
                    <span className="text-xl font-extrabold tabular-nums">
                      {formatNaira(quote.quote.total)}
                    </span>
                  </div>

                  <p className="mt-3">
                    <EstimateNote>
                      Estimated {quote.estimatedDeliveryMinutes} minutes. This is an estimate, not a
                      guarantee — traffic and kitchen load change it.
                    </EstimateNote>
                  </p>
                </Card>
              )}
            </section>

            {placeError ? (
              <div className="mt-4">
                <ErrorState
                  title="Could not place your order"
                  message={placeError.message}
                  requestId={placeError.requestId}
                />
              </div>
            ) : null}

            <div className="sticky bottom-0 mt-6 border-t bg-[var(--surface)] py-4">
              <Button
                size="lg"
                className="w-full"
                disabled={quote === null || quoting || placing}
                onClick={() => void placeOrder()}
              >
                {placing
                  ? 'Placing your order…'
                  : quote
                    ? `Confirm and pay ${formatNaira(quote.quote.total)}`
                    : 'Confirm order'}
              </Button>
              <p className="mt-2 text-center text-xs text-graphite-400">
                Payments run through a mock adapter in this build. No card is charged.
              </p>
            </div>
          </>
        )}
      </main>
    </>
  );
}
