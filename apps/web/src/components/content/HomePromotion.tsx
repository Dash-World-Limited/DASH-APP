'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { PublicContentItem } from '@dash/domain/content';
import { studioSlot } from '@dash/domain/content/presentation';
import { useStudioContent } from '@/lib/useStudioContent';
function Hero({ item }: { item: PublicContentItem }) {
  const [failed, setFailed] = useState(false);
  if (!item.image || failed) return null;
  const card = (
    <>
      <img
        src={item.image.url}
        alt={item.image.alt}
        className="h-40 w-full object-cover sm:h-52"
        onError={() => setFailed(true)}
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
/** Standalone, or reuse the parent page's optional feed. */
export function HomePromotion({
  items,
}: {
  items?: readonly PublicContentItem[];
}) {
  const loaded = useStudioContent(items === undefined);
  const hero = studioSlot(items ?? loaded, 'home.hero').find(
    (item) => item.image,
  );
  return hero ? (
    <Hero key={`${hero.id}:${hero.revision}:${hero.image?.url}`} item={hero} />
  ) : null;
}
