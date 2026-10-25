import { z } from 'zod';
import { SERVICE_CATEGORY_IDS } from '../services/index.js';

/** V1 is a controlled presentation contract, never executable markup. */
export const CONTENT_TYPES = [
  'banner',
  'promotion',
  'announcement',
  'featured_vendor',
  'vendor_presentation',
  'category_artwork',
  'collection',
  'faq',
  'policy',
  'campaign',
] as const;
export const CONTENT_PLACEMENTS = [
  'home.hero',
  'home.promotions',
  'home.announcements',
  'home.featured',
  'category.artwork',
  'vendor.presentation',
  'help',
  'legal',
] as const;
const placementsByType: Record<
  (typeof CONTENT_TYPES)[number],
  readonly string[]
> = {
  banner: ['home.hero', 'home.promotions'],
  promotion: ['home.promotions'],
  announcement: ['home.announcements'],
  featured_vendor: ['home.featured'],
  vendor_presentation: ['vendor.presentation'],
  category_artwork: ['category.artwork'],
  collection: ['home.featured'],
  faq: ['help'],
  policy: ['legal'],
  campaign: ['home.hero', 'home.promotions'],
};
export const contentSchema = z
  .object({
    internalName: z.string().trim().min(1).max(120),
    type: z.enum(CONTENT_TYPES),
    placement: z.enum(CONTENT_PLACEMENTS),
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().max(5000).default(''),
    mediaId: z.string().cuid().nullable().default(null),
    logoMediaId: z.string().cuid().nullable().default(null),
    vendorId: z.string().cuid().nullable().default(null),
    categoryId: z.enum(SERVICE_CATEGORY_IDS).nullable().default(null),
    // Only known app destinations. No external links, scheme-relative URLs or scripts.
    href: z
      .string()
      .max(200)
      .regex(
        /^\/(?:home|restaurants|shops|market|pharmacy|declutter|browse\/[a-z0-9-]+)$/,
      )
      .nullable()
      .default(null),
    label: z.string().trim().max(40).default(''),
    featured: z.boolean().default(false),
    position: z.number().int().min(0).max(10000).default(0),
    visible: z.boolean().default(true),
    startsAt: z.string().datetime().nullable().default(null),
    endsAt: z.string().datetime().nullable().default(null),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (!placementsByType[data.type].includes(data.placement))
      ctx.addIssue({
        code: 'custom',
        path: ['placement'],
        message: 'Choose a placement supported by this content type.',
      });
    if (
      ['vendor_presentation', 'featured_vendor'].includes(data.type) &&
      !data.vendorId
    )
      ctx.addIssue({
        code: 'custom',
        path: ['vendorId'],
        message: 'Select a vendor.',
      });
    if (data.type === 'category_artwork' && !data.categoryId)
      ctx.addIssue({
        code: 'custom',
        path: ['categoryId'],
        message: 'Select a service category.',
      });
    if (data.startsAt && data.endsAt && data.endsAt <= data.startsAt)
      ctx.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'End must follow start.',
      });
  });
export type ContentInput = z.infer<typeof contentSchema>;
export function contentIsVisible(data: ContentInput, now: Date): boolean {
  return (
    data.visible &&
    (!data.startsAt || new Date(data.startsAt) <= now) &&
    (!data.endsAt || new Date(data.endsAt) > now)
  );
}
export interface PublicContentItem {
  id: string;
  revision: number;
  type: ContentInput['type'];
  placement: ContentInput['placement'];
  title: string;
  body: string;
  href: string | null;
  label: string;
  position: number;
  featured: boolean;
  vendorId: string | null;
  categoryId: ContentInput['categoryId'];
  image: { url: string; alt: string; width: number; height: number } | null;
  logo: PublicContentItem['image'];
}
export interface PublishedContent {
  schemaVersion: 1;
  version: string;
  items: PublicContentItem[];
}
