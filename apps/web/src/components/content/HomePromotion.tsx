'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { PublicContentItem } from '@dash/domain/content';
import { API_BASE } from '@/lib/api';
import { contentImageUrl } from '@/lib/content-media';

/** Optional enhancement: independent of serviceability, catalogue and orders. */
export function HomePromotion() {
  const [item, setItem] = useState<PublicContentItem | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    void fetch(`${API_BASE}/v1/content?placement=home.hero`, {
      signal: controller.signal,
      credentials: 'omit',
    })
      .then(async (response) => {
        if (!response.ok) return;
        const data: unknown = await response.json();
        if (
          !data ||
          typeof data !== 'object' ||
          !('schemaVersion' in data) ||
          data.schemaVersion !== 1 ||
          !('items' in data) ||
          !Array.isArray(data.items)
        )
          return;
        // Old clients ignore unknown component types and malformed payloads.
        const next = (data.items as PublicContentItem[]).find(
          (candidate) =>
            candidate &&
            ['banner', 'campaign'].includes(candidate.type) &&
            candidate.placement === 'home.hero' &&
            typeof candidate.title === 'string' &&
            typeof candidate.body === 'string' &&
            candidate.image &&
            typeof candidate.image.url === 'string' &&
            typeof candidate.image.alt === 'string' &&
            contentImageUrl(candidate.image.url) !== null &&
            (candidate.href === null ||
              /^\/(?:home|restaurants|shops|market|pharmacy|declutter|browse\/[a-z0-9-]+)$/.test(
                candidate.href,
              )),
        );
        if (!cancelled && next) setItem(next);
      })
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, []);
  // Existing home navigation is the default before loading and after any
  // failure. Never reserve a blocking skeleton or surface a CMS error here.
  if (!item || imageFailed || !item.image) return null;
  const card = (
    <>
      <img
        src={contentImageUrl(item.image.url) ?? undefined}
        alt={item.image.alt}
        className="h-40 w-full object-cover sm:h-52"
        onError={() => setImageFailed(true)}
      />
      <div className="p-5">
        <h2 className="text-xl font-extrabold">{item.title}</h2>
        {item.body && <p className="mt-1 text-sm">{item.body}</p>}
      </div>
    </>
  );
  return (
    <section
      aria-label="DASH highlights"
      className="mt-6 overflow-hidden rounded-[var(--radius-card)] border bg-[var(--surface-raised)]"
    >
      {item.href ? <Link href={item.href}>{card}</Link> : card}
    </section>
  );
}
