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
  formatNaira,
} from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { authedFetch, useHasSession } from '@/lib/session';

interface VendorOrder {
  id: string;
  code: string;
  status: string;
  mode: string;
  itemsSubtotal: number;
  total: number;
  createdAt: string;
  placedAt: string | null;
  estimatedReadyAt: string | null;
  instructions: string | null;
  items: {
    nameSnapshot: string;
    quantity: number;
    modifiers: unknown;
    instructions: string | null;
  }[];
  customer: { name: string };
  rider: { name: string | null } | null;
}

type Tab = 'incoming' | 'active' | 'completed';

const REJECT_REASONS = [
  { value: 'out_of_stock', label: 'Out of stock' },
  { value: 'too_busy', label: 'Too busy right now' },
  { value: 'closing_soon', label: 'Closing soon' },
  { value: 'cannot_fulfil_instructions', label: 'Cannot meet the instructions' },
  { value: 'other', label: 'Another reason' },
] as const;

export default function VendorConsolePage() {
  const [tab, setTab] = useState<Tab>('incoming');
  const [orders, setOrders] = useState<VendorOrder[] | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const signedIn = useHasSession();

  const load = useCallback(async (): Promise<void> => {
    if (!signedIn) {
      setOrders([]);
      return;
    }
    try {
      const result = await authedFetch<{ orders: VendorOrder[] }>(
        `/v1/vendor/orders?status=${tab}`,
      );
      setOrders(result.orders);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught
          : new ApiRequestError(0, 'unknown', 'Could not load the order queue.'),
      );
      setOrders([]);
    }
  }, [tab, signedIn]);

  useEffect(() => {
    void load();
  }, [load]);

  // A kitchen cannot watch a screen. Poll briskly so a new order shows up fast.
  useEffect(() => {
    if (!signedIn) return;
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [load, signedIn]);

  const act = async (id: string, run: () => Promise<unknown>): Promise<void> => {
    setBusyId(id);
    try {
      await run();
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught
          : new ApiRequestError(0, 'unknown', 'That action did not go through.'),
      );
    } finally {
      setBusyId(null);
    }
  };

  if (!signedIn) {
    return (
      <>
        <AppHeader variant="staff" />
        <main id="main" className="mx-auto max-w-4xl px-5 py-12">
          <EmptyState
            title="Sign in to your vendor account"
            description="The order queue is only visible to the vendor it belongs to."
            action={
              <Link href="/signin?next=/vendor">
                <Button>Sign in</Button>
              </Link>
            }
          />
        </main>
      </>
    );
  }

  return (
    <>
      <AppHeader variant="staff" />
      <main id="main" className="mx-auto max-w-4xl px-5 py-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-3xl font-extrabold tracking-tight">Order queue</h1>
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            Refresh
          </Button>
        </div>

        <div className="mt-6 flex gap-1 rounded-xl border p-1" role="tablist">
          {(['incoming', 'active', 'completed'] as const).map((option) => (
            <button
              key={option}
              role="tab"
              aria-selected={tab === option}
              onClick={() => {
                setTab(option);
                setOrders(null);
              }}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold capitalize transition-colors ${
                tab === option ? 'bg-graphite-900 text-white' : 'hover:bg-[var(--surface-raised)]'
              }`}
            >
              {option}
            </button>
          ))}
        </div>

        {error ? (
          <div className="mt-4">
            <ErrorState
              message={error.message}
              requestId={error.requestId}
              onRetry={() => void load()}
            />
          </div>
        ) : null}

        <div className="mt-6">
          {orders === null ? (
            <LoadingBlock label="Loading orders" />
          ) : orders.length === 0 ? (
            <EmptyState
              title={tab === 'incoming' ? 'No new orders' : `Nothing ${tab}`}
              description={
                tab === 'incoming'
                  ? 'New orders appear here automatically. The list refreshes every few seconds.'
                  : 'Orders will show up here as they move through.'
              }
            />
          ) : (
            <ul className="space-y-4">
              {orders.map((order) => (
                <Card as="li" key={order.id} className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="font-mono font-bold">{order.code}</h2>
                        <Badge tone={order.status === 'placed' ? 'gold' : 'neutral'}>
                          {order.status.replace(/_/g, ' ')}
                        </Badge>
                        {order.mode === 'pickup' ? <Badge>Pickup</Badge> : null}
                      </div>
                      <p className="mt-1 text-sm text-graphite-600">
                        {order.customer.name} ·{' '}
                        {new Date(order.placedAt ?? order.createdAt).toLocaleTimeString('en-NG', {
                          timeStyle: 'short',
                        })}
                      </p>
                    </div>
                    <span className="text-lg font-extrabold tabular-nums">
                      {formatNaira(order.itemsSubtotal)}
                    </span>
                  </div>

                  <ul className="mt-4 space-y-1.5 border-t pt-4">
                    {order.items.map((item, index) => (
                      <li key={index} className="text-sm">
                        <span className="font-semibold">{item.quantity}×</span>{' '}
                        {item.nameSnapshot}
                        {Array.isArray(item.modifiers) && item.modifiers.length > 0 ? (
                          <span className="block pl-6 text-xs text-graphite-600">
                            {(item.modifiers as { name: string }[])
                              .map((modifier) => modifier.name)
                              .join(', ')}
                          </span>
                        ) : null}
                        {item.instructions ? (
                          <span className="block pl-6 text-xs font-medium text-coral-600">
                            Note: {item.instructions}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>

                  {order.instructions ? (
                    <p className="mt-3 rounded-lg bg-gold-50 px-3 py-2 text-sm">
                      <strong>Delivery note:</strong> {order.instructions}
                    </p>
                  ) : null}

                  {/* --- Actions --------------------------------------------- */}
                  <div className="mt-5 flex flex-wrap gap-2">
                    {(order.status === 'placed' || order.status === 'vendor_reviewing') && (
                      <>
                        <Button
                          disabled={busyId === order.id}
                          onClick={() =>
                            void act(order.id, () =>
                              authedFetch(`/v1/vendor/orders/${order.id}/accept`, {
                                method: 'POST',
                                body: { prepMinutes: 20 },
                              }),
                            )
                          }
                        >
                          Accept · 20 min
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={busyId === order.id}
                          onClick={() =>
                            void act(order.id, () =>
                              authedFetch(`/v1/vendor/orders/${order.id}/accept`, {
                                method: 'POST',
                                body: { prepMinutes: 40 },
                              }),
                            )
                          }
                        >
                          Accept · 40 min
                        </Button>
                        <Button
                          variant="danger"
                          disabled={busyId === order.id}
                          onClick={() => {
                            const reason = window.prompt(
                              `Why are you rejecting ${order.code}?\n\n${REJECT_REASONS.map(
                                (option, index) => `${index + 1}. ${option.label}`,
                              ).join('\n')}\n\nEnter a number 1–5:`,
                            );
                            const index = Number(reason) - 1;
                            const chosen = REJECT_REASONS[index];
                            if (!chosen) return;
                            void act(order.id, () =>
                              authedFetch(`/v1/vendor/orders/${order.id}/reject`, {
                                method: 'POST',
                                body: { reasonCode: chosen.value },
                              }),
                            );
                          }}
                        >
                          Reject
                        </Button>
                      </>
                    )}

                    {order.status === 'accepted' ? (
                      <Button
                        disabled={busyId === order.id}
                        onClick={() =>
                          void act(order.id, () =>
                            authedFetch(`/v1/vendor/orders/${order.id}/progress`, {
                              method: 'POST',
                              body: { to: 'preparing' },
                            }),
                          )
                        }
                      >
                        Start preparing
                      </Button>
                    ) : null}

                    {order.status === 'preparing' ? (
                      <Button
                        disabled={busyId === order.id}
                        onClick={() =>
                          void act(order.id, () =>
                            authedFetch(`/v1/vendor/orders/${order.id}/progress`, {
                              method: 'POST',
                              body: { to: 'ready' },
                            }),
                          )
                        }
                      >
                        Mark ready for pickup
                      </Button>
                    ) : null}

                    {order.status === 'ready' || order.status === 'rider_assigned' ? (
                      <Button
                        variant="ghost"
                        disabled={busyId === order.id}
                        onClick={() => {
                          const code = window.prompt(
                            `Ask the rider for the 4-digit pickup code for ${order.code}:`,
                          );
                          if (!code) return;
                          void act(order.id, async () => {
                            await authedFetch(`/v1/vendor/orders/${order.id}/verify-pickup`, {
                              method: 'POST',
                              body: { code },
                            });
                            window.alert('Pickup code verified. Hand over the order.');
                          });
                        }}
                      >
                        Verify pickup code
                      </Button>
                    ) : null}
                  </div>

                  {order.rider?.name ? (
                    <p className="mt-3 text-sm text-graphite-600">
                      Rider: <strong>{order.rider.name}</strong>
                    </p>
                  ) : null}
                </Card>
              ))}
            </ul>
          )}
        </div>
      </main>
    </>
  );
}
