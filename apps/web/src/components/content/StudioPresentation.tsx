'use client';
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import type { PublicContentItem } from '@dash/domain/content';
import {
  categoryArtwork,
  studioSlot,
  vendorPresentation,
  vendorFeature,
} from '@dash/domain/content/presentation';
export function StudioImage({
  image,
  className,
  fallback = null,
}: {
  image: PublicContentItem['image'];
  className?: string;
  fallback?: ReactNode;
}) {
  return image ? (
    <Remote
      key={image.url}
      image={image}
      className={className}
      fallback={fallback}
    />
  ) : (
    <>{fallback}</>
  );
}
function Remote({
  image,
  className,
  fallback,
}: {
  image: NonNullable<PublicContentItem['image']>;
  className?: string;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <>{fallback}</>
  ) : (
    <img
      src={image.url}
      alt={image.alt}
      className={className}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
export function StudioCategoryArtwork({
  items,
  categoryId,
}: {
  items: readonly PublicContentItem[];
  categoryId: string;
}) {
  return (
    <StudioImage
      image={categoryArtwork(items, categoryId)}
      className="mb-3 h-24 w-full rounded-xl object-cover"
    />
  );
}
export function StudioVendorArtwork({
  items,
  vendorId,
  storefront = false,
}: {
  items: readonly PublicContentItem[];
  vendorId: string;
  storefront?: boolean;
}) {
  const presentation = vendorPresentation(items, vendorId);
  const feature = vendorFeature(items, vendorId);
  const label =
    presentation?.label ||
    feature?.label ||
    (feature ? 'Featured by DASH' : '');
  return (
    <>
      <StudioImage
        image={presentation?.image ?? null}
        className={
          storefront
            ? 'mb-4 h-48 w-full rounded-2xl object-cover'
            : 'mb-3 h-28 w-full rounded-xl object-cover'
        }
      />
      <StudioImage
        image={presentation?.logo ?? null}
        className="mb-2 h-12 w-12 rounded-xl object-cover"
      />
      {label && (
        <span className="mb-2 inline-block rounded-full bg-gold-50 px-2 py-1 text-xs font-semibold text-gold-600">
          {label}
        </span>
      )}
    </>
  );
}
function Promotion({ item }: { item: PublicContentItem }) {
  const [failed, setFailed] = useState(false);
  if (!item.image || failed) return null;
  const body = (
    <>
      <img
        src={item.image.url}
        alt={item.image.alt}
        className="h-28 w-full object-cover"
        onError={() => setFailed(true)}
      />
      <div className="p-4">
        <h2 className="font-bold">{item.title}</h2>
        <p className="mt-1 text-sm text-[var(--ink-muted)]">{item.body}</p>
      </div>
    </>
  );
  return (
    <article className="overflow-hidden rounded-2xl border bg-[var(--surface-raised)]">
      {item.href ? <Link href={item.href}>{body}</Link> : body}
    </article>
  );
}
export function StudioDiscovery({
  items,
}: {
  items: readonly PublicContentItem[];
}) {
  const announcements = studioSlot(items, 'home.announcements').slice(0, 2);
  const cards = [
    ...studioSlot(items, 'home.promotions'),
    ...studioSlot(items, 'home.featured').filter(
      (item) => item.type === 'collection',
    ),
  ].slice(0, 4);
  if (!announcements.length && !cards.length) return null;
  return (
    <aside aria-label="DASH discovery" className="mt-6 space-y-3">
      {announcements.map((item) => (
        <div key={item.id} className="rounded-xl border px-4 py-3">
          <h2 className="font-semibold">{item.title}</h2>
          <p className="text-sm text-[var(--ink-muted)]">{item.body}</p>
        </div>
      ))}
      {cards.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {cards.map((item) => (
            <Promotion key={`${item.id}:${item.revision}`} item={item} />
          ))}
        </div>
      )}
    </aside>
  );
}
