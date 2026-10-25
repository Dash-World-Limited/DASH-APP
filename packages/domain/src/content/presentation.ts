import { z } from 'zod';
import {
  CONTENT_TYPES,
  CONTENT_PLACEMENTS,
  type PublicContentItem,
} from './index.js';
import { SERVICE_CATEGORY_IDS } from '../services/index.js';

export const STUDIO_TIMEOUT_MS = 2500;
export function studioImageUrl(value: unknown, baseUrl: string): string | null {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    !(/^https?:\/\//.test(value) || value.startsWith('/v1/files/'))
  )
    return null;
  try {
    const url = new URL(value, baseUrl);
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
const imageSchema = z.object({
  url: z.string(),
  alt: z.string().max(300),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
const itemSchema = z.object({
  id: z.string().min(1).max(64),
  revision: z.number().int().positive().default(1),
  type: z.enum(CONTENT_TYPES),
  placement: z.enum(CONTENT_PLACEMENTS),
  title: z.string().min(1).max(160),
  body: z.string().max(5000).default(''),
  label: z.string().max(40).default(''),
  position: z.number().int().min(0).max(10000).default(0),
  featured: z.boolean().default(false),
  href: z
    .string()
    .regex(
      /^\/(?:home|restaurants|shops|market|pharmacy|declutter|browse\/[a-z0-9-]+)$/,
    )
    .nullable()
    .default(null),
  vendorId: z.string().min(1).max(64).nullable().default(null),
  categoryId: z.enum(SERVICE_CATEGORY_IDS).nullable().default(null),
  image: imageSchema.nullable().default(null),
  logo: imageSchema.nullable().default(null),
});
/** Published transport is still untrusted input. Invalid/new components are skipped independently. */
export function parseStudioFeed(
  value: unknown,
  baseUrl: string,
): PublicContentItem[] {
  if (
    !value ||
    typeof value !== 'object' ||
    !('schemaVersion' in value) ||
    value.schemaVersion !== 1 ||
    !('items' in value) ||
    !Array.isArray(value.items)
  )
    return [];
  const result: PublicContentItem[] = [];
  const seen = new Set<string>();
  for (const raw of value.items.slice(0, 500)) {
    const parsed = itemSchema.safeParse(raw);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    const item = parsed.data;
    const image = (
      raw: z.infer<typeof imageSchema> | null,
    ): PublicContentItem['image'] => {
      if (!raw) return null;
      const url = studioImageUrl(raw.url, baseUrl);
      return url
        ? { ...raw, url, width: raw.width ?? 1, height: raw.height ?? 1 }
        : null;
    };
    result.push({ ...item, image: image(item.image), logo: image(item.logo) });
    seen.add(item.id);
  }
  return result.sort(
    (a, b) => a.position - b.position || a.id.localeCompare(b.id),
  );
}
/** The deadline covers response bodies too, even if a fetch implementation ignores abort. */
export async function loadStudioFeed(
  baseUrl: string | null,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<PublicContentItem[]> {
  if (!baseUrl || signal?.aborted) return [];
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => undefined;
  const deadline = new Promise<PublicContentItem[]>((resolve) => {
    cancel = () => {
      controller.abort();
      resolve([]);
    };
    timer = setTimeout(cancel, STUDIO_TIMEOUT_MS);
    signal?.addEventListener('abort', cancel, { once: true });
  });
  const request = (async () => {
    try {
      const response = await fetcher(
        `${baseUrl.replace(/\/$/, '')}/v1/content`,
        {
          signal: controller.signal,
          credentials: 'omit',
          headers: { Accept: 'application/json' },
        },
      );
      return response.ok ? parseStudioFeed(await response.json(), baseUrl) : [];
    } catch {
      return [];
    }
  })();
  try {
    return await Promise.race([request, deadline]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
export function studioSlot(
  items: readonly PublicContentItem[],
  placement: PublicContentItem['placement'],
): PublicContentItem[] {
  const types: Partial<
    Record<PublicContentItem['placement'], readonly PublicContentItem['type'][]>
  > = {
    'home.hero': ['banner', 'campaign'],
    'home.promotions': ['banner', 'promotion', 'campaign'],
    'home.announcements': ['announcement'],
    'home.featured': ['featured_vendor', 'collection'],
    'category.artwork': ['category_artwork'],
    'vendor.presentation': ['vendor_presentation'],
  };
  return items.filter(
    (item) =>
      item.placement === placement && types[placement]?.includes(item.type),
  );
}
export const categorySurfaceId = (id: string): string =>
  (
    ({
      restaurants: 'food',
      market: 'local_market',
      'local-market': 'local_market',
    }) as Record<string, string>
  )[id] ?? id;
export const categoryArtwork = (
  items: readonly PublicContentItem[],
  id: string,
) =>
  studioSlot(items, 'category.artwork').find(
    (item) => item.categoryId === categorySurfaceId(id) && item.image,
  )?.image ?? null;
export const vendorPresentation = (
  items: readonly PublicContentItem[],
  id: string,
) =>
  studioSlot(items, 'vendor.presentation').find((item) => item.vendorId === id);
export function vendorFeature(
  items: readonly PublicContentItem[],
  id: string,
): PublicContentItem | undefined {
  return items.find(
    (item) =>
      item.vendorId === id &&
      ((item.type === 'featured_vendor' &&
        item.placement === 'home.featured') ||
        (item.type === 'vendor_presentation' &&
          item.placement === 'vendor.presentation' &&
          item.featured)),
  );
}
/** Permutation only: no fetching, inserting, filtering, mutation or operational-field merging. */
export function orderStudioVendors<T>(
  vendors: readonly T[],
  items: readonly PublicContentItem[],
  idOf: (vendor: T) => string,
): T[] {
  return vendors
    .map((vendor, index) => ({
      vendor,
      index,
      feature: vendorFeature(items, idOf(vendor)),
    }))
    .sort((a, b) =>
      a.feature && b.feature
        ? a.feature.position - b.feature.position || a.index - b.index
        : a.feature
          ? -1
          : b.feature
            ? 1
            : a.index - b.index,
    )
    .map(({ vendor }) => vendor);
}
