/**
 * Discovery: serviceability, vendor browsing, and catalogue reads.
 *
 * These are the only broadly-public endpoints in the API. They are still
 * carefully bounded: pagination is cursor-based and capped, search input is
 * length-limited, and no endpoint here ever returns a vendor's bank details,
 * a customer's address, or anything owned by another party.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { haversineMetres } from '@dash/domain/geo';
import {
  LEGACY_VENDOR_CATEGORY_IDS,
  MERCHANT_SERVICE_CATEGORY_IDS,
  SERVICE_CATEGORIES,
  serviceCategoryForVendorCategory,
  vendorCategoriesForService,
} from '@dash/domain/services';
import { ApiError } from '../http/errors.js';

const coordinateSchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
});

const listQuerySchema = z.object({
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  service: z.enum(MERCHANT_SERVICE_CATEGORY_IDS).optional(),
  // Deprecated compatibility filter for clients released before the public
  // six-service taxonomy. Remove only after usage has reached zero.
  //
  // Includes `declutter`: the seeded Declutter seller is a real Vendor row that
  // the rider logistics tests run against, and the web Declutter section asks
  // for it by this value. Dropping it here would 400 that request.
  category: z.enum(LEGACY_VENDOR_CATEGORY_IDS).optional(),
  // Bounded to keep a pathological query from scanning the table.
  search: z.string().trim().max(80).optional(),
  sort: z.enum(['nearest', 'rating', 'name']).default('nearest'),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).superRefine((query, context) => {
  if (query.service && query.category) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Use service or category, not both.',
      path: ['service'],
    });
  }
});

export async function registerCatalogRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, geo } = app.services;

  // -------------------------------------------------------------------------
  // GET /v1/service-categories
  //
  // Stable public navigation contract shared by native and web clients.
  // Position is part of the contract: do not alphabetise this list.
  // -------------------------------------------------------------------------
  app.get('/v1/service-categories', async () => ({ categories: SERVICE_CATEGORIES }));

  // -------------------------------------------------------------------------
  // GET /v1/cities
  // -------------------------------------------------------------------------
  app.get('/v1/cities', async () => {
    const cities = await prisma.city.findMany({
      where: { isLive: true },
      select: {
        id: true,
        slug: true,
        name: true,
        currency: true,
        timezone: true,
        centreLatitude: true,
        centreLongitude: true,
      },
      orderBy: { name: 'asc' },
    });
    return { cities };
  });

  /**
   * Resolve one customer coordinate into the service context used by both
   * serviceability and discovery.
   *
   * Keeping this in one function matters: a point must not be described as
   * outside DASH by /serviceability while /vendors quietly returns merchants
   * from another city. The catalogue is a delivery catalogue whenever an
   * origin is supplied, so the same zone decision owns both answers.
   */
  async function resolveServiceability(point: { latitude: number; longitude: number }) {
    const cities = await prisma.city.findMany({
      where: { isLive: true },
      select: { id: true, slug: true, name: true },
    });

    for (const city of cities) {
      const zoneIds = await geo.zonesContaining(point, city.id);
      if (zoneIds.length === 0) continue;

      const zones = await prisma.zone.findMany({
        where: { id: { in: [...zoneIds] } },
        select: {
          id: true,
          name: true,
          slug: true,
          isActive: true,
          pausedReason: true,
          surgeMultiplier: true,
        },
      });

      const live = zones.filter((zone) => zone.isActive);
      if (live.length === 0) {
        return {
          serviceable: false as const,
          reason: 'zone_paused' as const,
          message:
            zones[0]?.pausedReason ??
            'Deliveries here are paused right now. Please try again shortly.',
          city,
          zone: null,
          busy: false,
        };
      }

      const primary = live[0];
      return {
        serviceable: true as const,
        city,
        zone: primary ? { id: primary.id, name: primary.name, slug: primary.slug } : null,
        // Surfaced so the UI can warn before the customer builds a basket.
        busy: (primary?.surgeMultiplier ?? 1) > 1,
      };
    }

    return {
      serviceable: false as const,
      reason: 'outside_service_area' as const,
      message: 'DASH APP does not deliver to this address yet.',
      city: null,
      zone: null,
      busy: false,
    };
  }

  // -------------------------------------------------------------------------
  // GET /v1/serviceability?latitude=&longitude=
  //
  // The first question the customer app asks: "do you deliver here?"
  // -------------------------------------------------------------------------
  app.get('/v1/serviceability', async (request) => {
    const point = coordinateSchema.parse(request.query);
    return resolveServiceability(point);
  });

  // -------------------------------------------------------------------------
  // GET /v1/vendors
  // -------------------------------------------------------------------------
  app.get('/v1/vendors', async (request) => {
    const query = listQuerySchema.parse(request.query);
    const vendorCategories = query.service
      ? vendorCategoriesForService(query.service)
      : query.category
        ? [query.category]
        : undefined;

    const origin =
      query.latitude !== undefined && query.longitude !== undefined
        ? { latitude: query.latitude, longitude: query.longitude }
        : null;

    // With a delivery origin, discovery is scoped by the exact same service
    // decision as /v1/serviceability. Returning a Lagos merchant to somebody
    // standing in Asaba merely because Lagos happened to be seeded first is not
    // "nearest"; it is a merchant the customer cannot order from.
    const service = origin ? await resolveServiceability(origin) : null;
    if (service && !service.serviceable) {
      return { vendors: [], nextCursor: null };
    }
    const serviceCityId = service?.city.id;

    const vendors = await prisma.vendor.findMany({
      where: {
        status: 'approved',
        ...(serviceCityId ? { cityId: serviceCityId } : {}),
        ...(vendorCategories ? { category: { in: [...vendorCategories] } } : {}),
        ...(query.search
          ? {
              OR: [
                { name: { contains: query.search } },
                { description: { contains: query.search } },
              ],
            }
          : {}),
        ...(query.cursor ? { id: { gt: query.cursor } } : {}),
      },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        category: true,
        logoKey: true,
        coverKey: true,
        ratingAverage: true,
        ratingCount: true,
        branches: {
          where: { isActive: true },
          select: {
            id: true,
            name: true,
            latitude: true,
            longitude: true,
            state: true,
            minimumOrder: true,
            defaultPrepMinutes: true,
            busyExtraMinutes: true,
            supportsDelivery: true,
            supportsPickup: true,
          },
          take: 1,
        },
      },
      // Fetch one extra to determine whether another page exists.
      take: query.limit + 1,
      orderBy: query.sort === 'rating' ? [{ ratingAverage: 'desc' }, { id: 'asc' }] : { id: 'asc' },
    });

    const hasMore = vendors.length > query.limit;
    const page = hasMore ? vendors.slice(0, query.limit) : vendors;

    const shaped = page.map((vendor) => {
      const branch = vendor.branches[0];
      const distanceMetres =
        origin && branch
          ? Math.round(haversineMetres(origin, { latitude: branch.latitude, longitude: branch.longitude }))
          : null;

      return {
        id: vendor.id,
        name: vendor.name,
        slug: vendor.slug,
        description: vendor.description,
        category: vendor.category,
        serviceCategory: serviceCategoryForVendorCategory(vendor.category),
        rating: { average: vendor.ratingAverage, count: vendor.ratingCount },
        branch: branch
          ? {
              id: branch.id,
              state: branch.state,
              minimumOrder: branch.minimumOrder,
              supportsDelivery: branch.supportsDelivery,
              supportsPickup: branch.supportsPickup,
              // An estimate, clearly named as one. Never presented as a promise.
              estimatedMinutes: branch.defaultPrepMinutes + branch.busyExtraMinutes,
            }
          : null,
        distanceMetres,
      };
    });

    if (query.sort === 'nearest' && origin) {
      shaped.sort((a, b) => (a.distanceMetres ?? Infinity) - (b.distanceMetres ?? Infinity));
    }

    return {
      vendors: shaped,
      nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    };
  });

  // -------------------------------------------------------------------------
  // GET /v1/vendors/:slug
  // -------------------------------------------------------------------------
  app.get<{ Params: { slug: string } }>('/v1/vendors/:slug', async (request) => {
    const vendor = await prisma.vendor.findUnique({
      where: { slug: request.params.slug },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        category: true,
        status: true,
        ratingAverage: true,
        ratingCount: true,
        // Deliberately absent: bankAccountCipher, bankAccountLast4,
        // commissionBasisPoints. None of that is a customer's business.
        branches: {
          where: { isActive: true },
          select: {
            id: true,
            name: true,
            address: true,
            latitude: true,
            longitude: true,
            state: true,
            busyExtraMinutes: true,
            minimumOrder: true,
            defaultPrepMinutes: true,
            supportsDelivery: true,
            supportsPickup: true,
            deliveryRadiusMetres: true,
            hours: {
              select: { dayOfWeek: true, opensAtMinute: true, closesAtMinute: true, isClosed: true },
              orderBy: { dayOfWeek: 'asc' },
            },
          },
        },
        categories: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            name: true,
            description: true,
            items: {
              where: { archivedAt: null },
              orderBy: { sortOrder: 'asc' },
              select: {
                id: true,
                name: true,
                description: true,
                price: true,
                imageKey: true,
                // Only ever set on Declutter listings; null elsewhere.
                condition: true,
                prepMinutes: true,
                isAvailable: true,
                requiresAgeCheck: true,
                allergens: true,
                modifierGroups: {
                  orderBy: { sortOrder: 'asc' },
                  select: {
                    id: true,
                    name: true,
                    minSelect: true,
                    maxSelect: true,
                    options: {
                      where: { isAvailable: true },
                      orderBy: { sortOrder: 'asc' },
                      select: { id: true, name: true, priceDelta: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    // An unapproved or suspended vendor is invisible, not "forbidden" — the
    // same response as one that does not exist.
    if (!vendor || vendor.status !== 'approved') throw ApiError.notFound();

    return {
      vendor: {
        ...vendor,
        serviceCategory: serviceCategoryForVendorCategory(vendor.category),
      },
    };
  });

  // -------------------------------------------------------------------------
  // GET /v1/search
  // -------------------------------------------------------------------------
  app.get('/v1/search', async (request) => {
    const query = z
      .object({
        q: z.string().trim().min(2, 'Enter at least two characters').max(80),
        limit: z.coerce.number().int().min(1).max(30).default(15),
      })
      .parse(request.query);

    const [vendors, items] = await Promise.all([
      prisma.vendor.findMany({
        where: { status: 'approved', name: { contains: query.q } },
        select: { id: true, name: true, slug: true, category: true, ratingAverage: true },
        take: query.limit,
      }),
      prisma.menuItem.findMany({
        where: {
          archivedAt: null,
          isAvailable: true,
          name: { contains: query.q },
          vendor: { status: 'approved' },
        },
        select: {
          id: true,
          name: true,
          price: true,
          vendor: { select: { id: true, name: true, slug: true } },
        },
        take: query.limit,
      }),
    ]);

    return {
      vendors: vendors.map((vendor) => ({
        ...vendor,
        serviceCategory: serviceCategoryForVendorCategory(vendor.category),
      })),
      items,
    };
  });
}
