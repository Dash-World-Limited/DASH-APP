'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AppHeader } from '@/components/AppHeader';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  formatDistance,
  formatNaira,
} from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { authedFetch, useHasSession } from '@/lib/session';

/**
 * Rider app.
 *
 * Rendered on the dark "field" surface: it is read outdoors, in sun, one-handed,
 * often in a hurry. Large targets, high contrast, and very little to read.
 */

interface Offer {
  id: string;
  expiresAt: string;
  pickupEtaSeconds: number;
  pickupDistanceMetres: number;
  order: {
    code: string;
    pickup: { name: string; address: string; latitude: number; longitude: number };
    dropoffArea: { latitude: number; longitude: number } | null;
    tripDistanceMetres: number | null;
    itemCount: number;
    estimatedReadyAt: string | null;
  };
}

interface Earnings {
  balanceOwed: number;
  completedDeliveries: number;
  recentEntries: { amount: number; memo: string; at: string }[];
}

type Availability = 'offline' | 'idle' | 'on_break';

export default function RiderPage() {
  const [availability, setAvailability] = useState<Availability>('offline');
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  const signedIn = useHasSession();

  const load = useCallback(async (): Promise<void> => {
    if (!signedIn) return;
    try {
      const [offerResult, earningsResult] = await Promise.all([
        authedFetch<{ offers: Offer[] }>('/v1/rider/offers'),
        authedFetch<Earnings>('/v1/rider/earnings'),
      ]);
      setOffers(offerResult.offers);
      setEarnings(earningsResult);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught
          : new ApiRequestError(0, 'unknown', 'Could not load your work.'),
      );
      setOffers([]);
    }
  }, [signedIn]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (availability !== 'idle') return;
    const timer = setInterval(() => void load(), 6000);
    return () => clearInterval(timer);
  }, [availability, load]);

  const setOnline = async (next: Availability): Promise<void> => {
    setBusy(true);
    try {
      await authedFetch('/v1/rider/availability', {
        method: 'POST',
        body: { availability: next },
      });
      setAvailability(next);
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught
          : new ApiRequestError(0, 'unknown', 'Could not change your status.'),
      );
    } finally {
      setBusy(false);
    }
  };

  /**
   * Report the rider's position.
   *
   * Only while they are actually online — an offline rider's location is not
   * collected at all, and the API rejects it too.
   */
  useEffect(() => {
    if (availability !== 'idle' || !navigator.geolocation) return;

    const report = (): void => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          void authedFetch('/v1/rider/location', {
            method: 'POST',
            body: {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy: position.coords.accuracy,
              recordedAt: new Date().toISOString(),
            },
          }).catch(() => undefined);
        },
        () => undefined,
        { enableHighAccuracy: true, timeout: 10_000 },
      );
    };

    report();
    const timer = setInterval(report, 20_000);
    return () => clearInterval(timer);
  }, [availability]);

  if (!signedIn) {
    return (
      <div data-surface="field" className="min-h-screen">
        <AppHeader variant="staff" />
        <main id="main" className="mx-auto max-w-2xl px-5 py-12">
          <EmptyState
            title="Sign in to start riding"
            description="Use the phone number on your rider account."
            action={
              <Link href="/signin?next=/rider">
                <Button>Sign in</Button>
              </Link>
            }
          />
        </main>
      </div>
    );
  }

  return (
    <div data-surface="field" className="min-h-screen">
      <AppHeader variant="staff" />
      <main id="main" className="mx-auto max-w-2xl px-5 py-8">
        {/* --- Online toggle -------------------------------------------------- */}
        <Card className="p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-[var(--ink-muted)]">You are</p>
              <p className="mt-0.5 text-2xl font-extrabold">
                {availability === 'idle'
                  ? 'Online'
                  : availability === 'on_break'
                    ? 'On a break'
                    : 'Offline'}
              </p>
            </div>
            <Badge tone={availability === 'idle' ? 'success' : 'neutral'}>
              {availability === 'idle' ? 'Taking offers' : 'Not taking offers'}
            </Badge>
          </div>

          <div className="mt-5 flex gap-2">
            {availability === 'idle' ? (
              <>
                <Button
                  variant="ghost"
                  size="lg"
                  className="flex-1"
                  disabled={busy}
                  onClick={() => void setOnline('on_break')}
                >
                  Take a break
                </Button>
                <Button
                  variant="danger"
                  size="lg"
                  className="flex-1"
                  disabled={busy}
                  onClick={() => void setOnline('offline')}
                >
                  Go offline
                </Button>
              </>
            ) : (
              <Button
                size="lg"
                className="w-full"
                disabled={busy}
                onClick={() => void setOnline('idle')}
              >
                Go online
              </Button>
            )}
          </div>

          {availability === 'idle' ? (
            <p className="mt-4 text-xs text-[var(--ink-muted)]">
              Your location is shared while you are online so orders can be matched to you, and
              stops the moment you go offline.
            </p>
          ) : null}
        </Card>

        {error ? (
          <div className="mt-4">
            <ErrorState
              message={error.message}
              requestId={error.requestId}
              onRetry={() => void load()}
            />
          </div>
        ) : null}

        {/* --- Offers --------------------------------------------------------- */}
        <section className="mt-8">
          <h2 className="text-lg font-bold">Delivery offers</h2>
          <div className="mt-3">
            {availability !== 'idle' ? (
              <EmptyState
                title="You are not online"
                description="Go online to start receiving delivery offers."
              />
            ) : offers === null ? (
              <LoadingBlock label="Checking for offers" />
            ) : offers.length === 0 ? (
              <EmptyState
                title="No offers right now"
                description="Stay online and offers will appear here as orders come in."
              />
            ) : (
              <ul className="space-y-3">
                {offers.map((offer) => (
                  <Card as="li" key={offer.id} className="border-gold-400 p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-mono text-sm text-[var(--ink-muted)]">
                          {offer.order.code}
                        </p>
                        <h3 className="mt-1 text-lg font-bold">{offer.order.pickup.name}</h3>
                        <p className="text-sm text-[var(--ink-muted)]">
                          {offer.order.pickup.address}
                        </p>
                      </div>
                      <OfferCountdown expiresAt={offer.expiresAt} />
                    </div>

                    <dl className="mt-4 grid grid-cols-3 gap-3 border-t pt-4 text-sm">
                      <div>
                        <dt className="text-[var(--ink-muted)]">To pickup</dt>
                        <dd className="mt-0.5 font-bold">
                          {formatDistance(offer.pickupDistanceMetres)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[var(--ink-muted)]">Trip</dt>
                        <dd className="mt-0.5 font-bold">
                          {formatDistance(offer.order.tripDistanceMetres)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[var(--ink-muted)]">Items</dt>
                        <dd className="mt-0.5 font-bold">{offer.order.itemCount}</dd>
                      </div>
                    </dl>

                    <div className="mt-5 flex gap-2">
                      <Button
                        variant="ghost"
                        size="lg"
                        className="flex-1"
                        onClick={() =>
                          void authedFetch(`/v1/rider/offers/${offer.id}/respond`, {
                            method: 'POST',
                            body: { accept: false },
                          }).then(() => load())
                        }
                      >
                        Decline
                      </Button>
                      <Button
                        size="lg"
                        className="flex-[2]"
                        onClick={() =>
                          void authedFetch(`/v1/rider/offers/${offer.id}/respond`, {
                            method: 'POST',
                            body: { accept: true },
                          }).then(() => load())
                        }
                      >
                        Accept
                      </Button>
                    </div>
                  </Card>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* --- Earnings ------------------------------------------------------- */}
        {earnings ? (
          <section className="mt-8">
            <h2 className="text-lg font-bold">Earnings</h2>
            <Card className="mt-3 p-5">
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-[var(--ink-muted)]">Owed to you</span>
                <span className="text-2xl font-extrabold tabular-nums">
                  {formatNaira(earnings.balanceOwed)}
                </span>
              </div>
              <p className="mt-1 text-sm text-[var(--ink-muted)]">
                {earnings.completedDeliveries} deliveries completed
              </p>

              {earnings.recentEntries.length > 0 ? (
                <ul className="mt-4 space-y-1.5 border-t pt-4">
                  {earnings.recentEntries.slice(0, 5).map((entry, index) => (
                    <li key={index} className="flex justify-between text-sm">
                      <span className="capitalize text-[var(--ink-muted)]">
                        {entry.memo.replace(/_/g, ' ')}
                      </span>
                      <span className="font-semibold tabular-nums">
                        {formatNaira(entry.amount)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
          </section>
        ) : null}
      </main>
    </div>
  );
}

/** Counts an offer down to its expiry. Offers time out after 30 seconds. */
function OfferCountdown({ expiresAt }: { expiresAt: string }) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000)),
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining(Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  return (
    <div
      className={`shrink-0 rounded-xl px-3 py-2 text-center ${
        remaining <= 10 ? 'bg-coral-400 text-white' : 'bg-gold-400 text-graphite-900'
      }`}
    >
      <span className="block text-xl font-extrabold tabular-nums">{remaining}</span>
      <span className="block text-[10px] font-semibold uppercase">sec</span>
    </div>
  );
}
