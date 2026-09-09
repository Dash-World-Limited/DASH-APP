'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  formatNaira,
} from '@/components/ui';
import { ApiRequestError, type OrderSummary } from '@/lib/api';
import { authedFetch, useHasSession } from '@/lib/session';

const PHASE_TONE = {
  confirming: 'warning',
  preparing: 'warning',
  on_the_way: 'gold',
  complete: 'success',
  stopped: 'neutral',
} as const;

export default function OrdersPage() {
  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const signedIn = useHasSession();

  useEffect(() => {
    if (!signedIn) {
      setOrders([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await authedFetch<{ orders: OrderSummary[] }>('/v1/orders');
        if (!cancelled) setOrders(result.orders);
      } catch (caught) {
        if (!cancelled) {
          setError(
            caught instanceof ApiRequestError
              ? caught
              : new ApiRequestError(0, 'unknown', 'Could not load your orders.'),
          );
          setOrders([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  return (
    <>
      <main id="main" className="mx-auto max-w-3xl px-5 py-10">
        <h1 className="text-3xl font-extrabold tracking-tight">Your orders</h1>

        <div className="mt-6">
          {!signedIn ? (
            <EmptyState
              title="Sign in to see your orders"
              description="Your order history and live tracking live behind your account."
              action={
                <Link href="/signin?next=/orders">
                  <Button>Sign in</Button>
                </Link>
              }
            />
          ) : error ? (
            <ErrorState message={error.message} requestId={error.requestId} />
          ) : orders === null ? (
            <LoadingBlock label="Loading your orders" />
          ) : orders.length === 0 ? (
            <EmptyState
              title="No orders yet"
              description="When you place an order it will appear here, with live tracking while it is on the way."
              action={
                <Link href="/browse">
                  <Button>Browse vendors</Button>
                </Link>
              }
            />
          ) : (
            <ul className="space-y-3">
              {orders.map((order) => (
                <Card as="li" key={order.id} className="transition-shadow hover:shadow-md">
                  <Link href={`/orders/${order.id}`} className="block p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <h2 className="font-bold">{order.vendor.name}</h2>
                        <p className="mt-0.5 font-mono text-xs text-graphite-400">{order.code}</p>
                      </div>
                      <Badge tone={PHASE_TONE[order.phase]}>{order.statusLabel}</Badge>
                    </div>

                    <p className="mt-3 text-sm text-graphite-600">
                      {order.items
                        .map((item) => `${item.quantity}× ${item.nameSnapshot}`)
                        .join(', ')}
                    </p>

                    <div className="mt-3 flex items-baseline justify-between">
                      <span className="text-xs text-graphite-400">
                        {new Date(order.createdAt).toLocaleString('en-NG', {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </span>
                      <span className="font-bold tabular-nums">{formatNaira(order.total)}</span>
                    </div>
                  </Link>
                </Card>
              ))}
            </ul>
          )}
        </div>
      </main>
    </>
  );
}
