'use client';

import { SectionPage } from '@/components/SectionPage';
import { sectionBySlug } from '@/lib/sections';

/**
 * One of the five equal front doors. Everything it does lives in
 * `SectionPage` — see lib/sections.ts for why these are a table, not five
 * hand-built screens.
 */
export default function Page() {
  const section = sectionBySlug('shops');
  if (!section) return null;
  return (
    <div className="min-h-dvh">
      <SectionPage section={section} />
    </div>
  );
}
