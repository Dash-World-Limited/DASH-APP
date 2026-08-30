'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AppHeader } from '@/components/AppHeader';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  LoadingBlock,
  formatNaira,
  formatNairaCompact,
} from '@/components/ui';
import { apiFetch, ApiRequestError, type MenuItem, type VendorDetail } from '@/lib/api';
import { useBasket } from '@/lib/basket';

export default function VendorPage() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const { addLine } = useBasket();

  const [vendor, setVendor] = useState<VendorDetail | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [selected, setSelected] = useState<MenuItem | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await apiFetch<{ vendor: VendorDetail }>(`/v1/vendors/${params.slug}`);
        if (!cancelled) setVendor(result.vendor);
      } catch (caught) {
        if (!cancelled) {
          setError(
            caught instanceof ApiRequestError
              ? caught
              : new ApiRequestError(0, 'unknown', 'Could not load this vendor.'),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.slug]);

  if (error) {
    return (
      <>
        <AppHeader />
        <main id="main" className="mx-auto max-w-3xl px-5 py-12">
          <ErrorState
            title={error.status === 404 ? 'Vendor not found' : 'Could not load this vendor'}
            message={
              error.status === 404
                ? 'This vendor may have closed or is not available in your area.'
                : error.message
            }
            requestId={error.requestId}
          />
          <Button variant="ghost" className="mt-4" onClick={() => router.push('/browse')}>
            Back to browsing
          </Button>
        </main>
      </>
    );
  }

  if (!vendor) {
    return (
      <>
        <AppHeader />
        <main id="main" className="mx-auto max-w-3xl px-5 py-12">
          <LoadingBlock label="Loading vendor" />
        </main>
      </>
    );
  }

  const branch = vendor.branches[0];
  const closed = branch?.state === 'closed';

  return (
    <>
      <AppHeader />
      <main id="main" className="mx-auto max-w-3xl px-5 py-8">
        <header>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="text-3xl font-extrabold tracking-tight">{vendor.name}</h1>
            {closed ? <Badge tone="danger">Closed</Badge> : <Badge tone="success">Open</Badge>}
          </div>
          <p className="mt-2 text-graphite-600">{vendor.description}</p>

          <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <div className="flex gap-1.5">
              <dt className="text-graphite-400">Rating</dt>
              <dd className="font-semibold">
                {vendor.ratingAverage.toFixed(1)} ({vendor.ratingCount})
              </dd>
            </div>
            {branch ? (
              <>
                <div className="flex gap-1.5">
                  <dt className="text-graphite-400">Prep time</dt>
                  <dd className="font-semibold">
                    ~{branch.defaultPrepMinutes + branch.busyExtraMinutes} min
                  </dd>
                </div>
                {branch.minimumOrder > 0 ? (
                  <div className="flex gap-1.5">
                    <dt className="text-graphite-400">Minimum</dt>
                    <dd className="font-semibold">{formatNairaCompact(branch.minimumOrder)}</dd>
                  </div>
                ) : null}
                <div className="flex gap-1.5">
                  <dt className="text-graphite-400">Address</dt>
                  <dd>{branch.address}</dd>
                </div>
              </>
            ) : null}
          </dl>
        </header>

        {closed ? (
          <div className="mt-6 rounded-[var(--radius-card)] border border-coral-400/40 bg-coral-50 px-5 py-4 text-sm">
            <p className="font-semibold text-coral-600">This vendor is closed</p>
            <p className="mt-1 text-graphite-600">
              You can look at the menu, but you cannot order until they reopen.
            </p>
          </div>
        ) : null}

        <div className="mt-10 space-y-10">
          {vendor.categories.map((category) => (
            <section key={category.id}>
              <h2 className="text-xl font-bold">{category.name}</h2>
              {category.description ? (
                <p className="mt-1 text-sm text-graphite-600">{category.description}</p>
              ) : null}

              <ul className="mt-4 space-y-3">
                {category.items.map((item) => (
                  <Card as="li" key={item.id}>
                    <button
                      className="flex w-full items-start justify-between gap-4 p-5 text-left disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={closed || !item.isAvailable}
                      onClick={() => setSelected(item)}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold">{item.name}</h3>
                          {!item.isAvailable ? <Badge tone="danger">Sold out</Badge> : null}
                        </div>
                        {item.description ? (
                          <p className="mt-1 text-sm text-graphite-600">{item.description}</p>
                        ) : null}
                        <p className="mt-2 font-semibold">{formatNaira(item.price)}</p>
                      </div>
                      <span
                        aria-hidden
                        className="shrink-0 rounded-full border px-3 py-1 text-sm font-bold"
                      >
                        +
                      </span>
                    </button>
                  </Card>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </main>

      {selected && branch ? (
        <ItemDialog
          item={selected}
          onClose={() => setSelected(null)}
          onAdd={(modifierIds, quantity, modifierNames, unitPrice) => {
            const result = addLine({
              vendorSlug: vendor.slug,
              vendorName: vendor.name,
              branchId: branch.id,
              line: {
                itemId: selected.id,
                quantity,
                modifierIds,
                name: selected.name,
                unitPriceHint: unitPrice,
                modifierNames,
              },
            });
            setSelected(null);
            if (result.switchedVendor) {
              // Tell the customer their previous basket was replaced. Silently
              // discarding it would be a nasty surprise at checkout.
              window.alert(
                'Your basket had items from another vendor, so it has been replaced. DASH APP delivers one vendor per order.',
              );
            }
          }}
        />
      ) : null}
    </>
  );
}

/** Item customisation. Enforces the same min/max the server enforces. */
function ItemDialog({
  item,
  onClose,
  onAdd,
}: {
  item: MenuItem;
  onClose: () => void;
  onAdd: (
    modifierIds: string[],
    quantity: number,
    modifierNames: string[],
    unitPrice: number,
  ) => void;
}) {
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [quantity, setQuantity] = useState(1);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (groupId: string, optionId: string, maxSelect: number): void => {
    setChosen((current) => {
      const existing = current[groupId] ?? [];
      if (existing.includes(optionId)) {
        return { ...current, [groupId]: existing.filter((id) => id !== optionId) };
      }
      // A single-select group replaces rather than appends.
      if (maxSelect === 1) return { ...current, [groupId]: [optionId] };
      if (existing.length >= maxSelect) return current;
      return { ...current, [groupId]: [...existing, optionId] };
    });
  };

  const selectedIds = Object.values(chosen).flat();
  const selectedOptions = item.modifierGroups.flatMap((group) =>
    group.options.filter((option) => selectedIds.includes(option.id)),
  );
  const unitPrice =
    item.price + selectedOptions.reduce((total, option) => total + option.priceDelta, 0);

  // Mirrors the server's rule. The server re-checks regardless; this just avoids
  // a pointless round trip and a confusing error.
  const unmetGroup = item.modifierGroups.find(
    (group) => (chosen[group.id]?.length ?? 0) < group.minSelect,
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-graphite-900/50 p-0 sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Customise ${item.name}`}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-[var(--surface-raised)] sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sticky top-0 flex items-start justify-between gap-4 border-b bg-[var(--surface-raised)] p-5">
          <div>
            <h2 className="text-xl font-bold">{item.name}</h2>
            {item.description ? (
              <p className="mt-1 text-sm text-graphite-600">{item.description}</p>
            ) : null}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg px-3 py-1 text-xl leading-none hover:bg-graphite-100"
          >
            ×
          </button>
        </div>

        <div className="space-y-6 p-5">
          {item.modifierGroups.map((group) => (
            <fieldset key={group.id}>
              <legend className="font-semibold">
                {group.name}
                <span className="ml-2 text-xs font-normal text-graphite-400">
                  {group.minSelect > 0
                    ? `Choose ${group.minSelect === group.maxSelect ? group.minSelect : `${group.minSelect}–${group.maxSelect}`}`
                    : `Optional, up to ${group.maxSelect}`}
                </span>
              </legend>

              <div className="mt-3 space-y-2">
                {group.options.map((option) => {
                  const isChosen = (chosen[group.id] ?? []).includes(option.id);
                  return (
                    <label
                      key={option.id}
                      className={`flex cursor-pointer items-center justify-between rounded-xl border px-4 py-3 transition-colors ${
                        isChosen ? 'border-gold-400 bg-gold-50' : 'hover:bg-graphite-50'
                      }`}
                    >
                      <span className="flex items-center gap-3">
                        <input
                          type={group.maxSelect === 1 ? 'radio' : 'checkbox'}
                          name={group.id}
                          checked={isChosen}
                          onChange={() => toggle(group.id, option.id, group.maxSelect)}
                          className="h-4 w-4"
                        />
                        <span className="text-sm font-medium">{option.name}</span>
                      </span>
                      {option.priceDelta !== 0 ? (
                        <span className="text-sm text-graphite-600">
                          {option.priceDelta > 0 ? '+' : ''}
                          {formatNaira(option.priceDelta)}
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}

          <div className="flex items-center gap-4">
            <span className="text-sm font-semibold">Quantity</span>
            <div className="flex items-center gap-1 rounded-xl border">
              <button
                onClick={() => setQuantity((value) => Math.max(1, value - 1))}
                aria-label="Decrease quantity"
                className="px-4 py-2 text-lg font-bold disabled:opacity-40"
                disabled={quantity <= 1}
              >
                −
              </button>
              <span aria-live="polite" className="min-w-8 text-center font-semibold">
                {quantity}
              </span>
              <button
                onClick={() => setQuantity((value) => Math.min(50, value + 1))}
                aria-label="Increase quantity"
                className="px-4 py-2 text-lg font-bold"
              >
                +
              </button>
            </div>
          </div>
        </div>

        <div className="sticky bottom-0 border-t bg-[var(--surface-raised)] p-5">
          {unmetGroup ? (
            <p className="mb-3 text-sm font-medium text-coral-600">
              Choose an option for “{unmetGroup.name}” to continue.
            </p>
          ) : null}
          <Button
            size="lg"
            className="w-full"
            disabled={unmetGroup !== undefined}
            onClick={() =>
              onAdd(
                selectedIds,
                quantity,
                selectedOptions.map((option) => option.name),
                unitPrice,
              )
            }
          >
            Add {quantity} to basket · {formatNaira(unitPrice * quantity)}
          </Button>
        </div>
      </div>
    </div>
  );
}
