/**
 * The public marketplace.
 *
 * Three audiences share this file, and the differences between them are the
 * whole design:
 *
 *   * **An admin** turns an approved submission into a listing, and can pull
 *     one back. Publication is the only place a private record becomes a public
 *     page, so every precondition is checked in one function in the domain
 *     rather than spread across a route.
 *   * **A stranger** browses. They are unauthenticated, and everything they
 *     receive passes through `PublicListingCard` / `PublicListingDetail`, so a
 *     seller's phone number, address, coordinates or asking price cannot be
 *     leaked by a forgotten `select` — a route would have to add the field to
 *     the type, where review would see it.
 *   * **A buyer** asks to be put in touch. That is a request, not an action: it
 *     creates a record for a human to decide, and the default outcome is a DASH
 *     relay in which no seller detail leaves the platform at all.
 *
 * ## What a listing is allowed to claim
 *
 * Trust badges come from `trustBadges()` in the domain and are computed on
 * read, never stored. A stored badge is a claim that keeps being made after the
 * fact behind it stops being true — a suspended seller whose listings still say
 * "Verified Listing" is exactly the failure this avoids.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '@dash/db';
import {
  availabilityMachine,
  canPublish,
  contactRequestMachine,
  DeclutterTransitionError,
  DEFAULT_CONTACT_METHOD,
  disclosedFieldsFor,
  isMediatedContact,
  isPubliclyActionable,
  isPubliclyVisible,
  listingSlug,
  LISTING_SORTS,
  moderationMachine,
  photoAlt,
  publicAttributes,
  publicationGaps,
  publicLocation,
  requiresApprovalReason,
  requiresSellerConsent,
  trustBadges,
  type AvailabilityState,
  type ContactMethod,
  type ContactRequestState,
  type KycState,
  type ListingSort,
  type ModerationState,
  type TrustBadge,
} from '@dash/domain/declutter';
import { ApiError } from '../http/errors.js';
import { notifyListingPublished } from '../declutter/notifications.js';
import { notificationEmail } from '../declutter/notification-delivery.js';
import { facts, hubInclude } from '../declutter/hub.js';
import { hubBlockers } from '@dash/domain/declutter';
import { actorOf, requireAuth, requirePermission } from '../http/context.js';
import { auditContext, customerIdOf, declutterActorFor, PHOTO_LINK_SECONDS } from './declutter-shared.js';

/**
 * How many listings a feed page carries.
 *
 * Small enough that a handset on a slow connection renders something quickly,
 * and the cap exists so a scripted caller cannot ask for the whole marketplace
 * in one request and turn the feed into a bulk export.
 */
const PAGE_SIZE_DEFAULT = 24;
const PAGE_SIZE_MAX = 48;

const listQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(60).optional(),
  location: z.string().trim().max(60).optional(),
  condition: z.enum(['new', 'like_new', 'good', 'fair']).optional(),
  minPriceKobo: z.coerce.number().int().min(0).max(100_000_000_000).optional(),
  maxPriceKobo: z.coerce.number().int().min(0).max(100_000_000_000).optional(),
  sort: z.enum(LISTING_SORTS).default('newest'),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
  cursor: z.string().trim().max(60).optional(),
});

const moderationSchema = z.object({
  to: z.enum(['approved', 'rejected', 'suspended', 'pending_review']),
  reason: z.string().trim().max(500).optional(),
});

const availabilitySchema = z.object({
  to: z.enum(['available', 'reserved', 'unavailable', 'sold', 'archived']),
  reason: z.string().trim().max(500).optional(),
});

const contactRequestSchema = z.object({
  // Questions about the item. Never an offer — there is nothing to negotiate,
  // and a message field that invited one would teach buyers the wrong thing
  // about this marketplace on their first interaction with it.
  message: z.string().trim().max(600).optional(),
});

const contactDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  method: z.enum(['dash_relay', 'masked_relay', 'whatsapp_direct', 'phone_direct']).optional(),
  reason: z.string().trim().max(500).optional(),
  /** Evidence the seller agreed to a direct method. Required for one. */
  sellerConsentEvidence: z.string().trim().max(300).optional(),
});

export async function registerDeclutterListingRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app.services;

  // =========================================================================
  // Shared shaping
  // =========================================================================

  type PhotoRow = { storageKey: string; role: string; caption: string | null; position: number };

  async function signedPhoto(photo: PhotoRow, title: string) {
    return {
      url: await app.services.storage.signedUrl(photo.storageKey, PHOTO_LINK_SECONDS),
      alt: photoAlt(title, photo.role, photo.caption),
      role: photo.role,
    };
  }

  /**
   * The facts behind a listing's badges.
   *
   * `liveValuationAt` is null for every listing in the product today, because
   * no live valuation provider exists yet. Passed explicitly rather than
   * defaulted inside `trustBadges` so the day a provider lands, the change is
   * visible here rather than hidden in the domain.
   */
  function badgesFor(listing: {
    moderationStatus: string;
    seller: { kycStatus: string; sellerType: string };
  }): readonly TrustBadge[] {
    return trustBadges({
      moderationApproved: listing.moderationStatus === 'approved',
      sellerKycStatus: listing.seller.kycStatus as KycState,
      // Trusted Partner is a seller *type*, granted only by a super admin. It
      // is read here rather than stored on the listing so revoking the
      // agreement removes the badge from every page at once.
      sellerIsTrustedPartner: listing.seller.sellerType === 'trusted_partner',
      liveValuationAt: null,
      priceAuthorizedByHuman: true,
    });
  }

  // =========================================================================
  // Publication
  // =========================================================================

  /**
   * GET /v1/admin/declutter/submissions/:id/publication-readiness
   *
   * What is still missing. Separate from the publish call so the console can
   * show an admin the checklist before they press the button, rather than
   * teaching it to them through a sequence of refusals.
   */
  app.get(
    '/v1/admin/declutter/submissions/:id/publication-readiness',
    { preHandler: requirePermission('declutter:submission:read') },
    async (request) => {
      const { id } = z.object({ id: z.string().min(1).max(40) }).parse(request.params);
      const submission = await prisma.declutterSubmission.findUnique({
        where: { id },
        include: {
          seller: true,
          photos: true,
          listing: { select: { id: true } },
          fraudFlags: { where: { status: 'open' } },
        },
      });
      if (!submission) throw ApiError.notFound();

      const gaps = publicationGaps({
        sellerKycStatus: submission.seller.kycStatus as KycState,
        valueCheckStatus: submission.valueCheckStatus,
        authorizedPriceKobo: submission.authorizedPriceKobo,
        authorizationVersion: submission.authorizationVersion,
        sellerAcceptedPriceKobo: submission.sellerAcceptedPriceKobo,
        sellerAcceptedVersion: submission.sellerAcceptedVersion,
        categoryId: submission.categoryId,
        locationId: submission.locationId,
        photoCount: submission.photos.length,
        title: submission.title,
        description: submission.description,
        openFraudFlags: submission.fraudFlags.length,
        alreadyHasListing: submission.listing !== null,
      });

      return { gaps, canPublish: gaps.length === 0 };
    },
  );

  /**
   * POST /v1/admin/declutter/submissions/:id/publish
   *
   * The moment a private record becomes a public page.
   *
   * Everything is copied onto the listing rather than joined back to the
   * submission: title, description, price, condition, attributes and the
   * photographs themselves. A published listing must keep showing exactly what
   * a human approved even if the submission is edited afterwards, and a join
   * would let a later edit silently change a live page.
   *
   * The whole thing is one transaction. A listing that exists while its
   * submission still says `approved` would be a page nobody can find in the
   * console, and a submission marked `published` with no listing would be an
   * item the seller believes is for sale and nobody can buy.
   */
  app.post(
    '/v1/admin/declutter/submissions/:id/publish',
    { preHandler: requirePermission('declutter:listing:publish') },
    async (request, reply) => {
      const actor = actorOf(request);
      const acting = declutterActorFor(actor);
      const { id } = z.object({ id: z.string().min(1).max(40) }).parse(request.params);

      const submission = await prisma.declutterSubmission.findUnique({
        where: { id },
        include: {
          seller: true,
          category: true,
          photos: { orderBy: { position: 'asc' } },
          listing: { select: { id: true } },
          fraudFlags: { where: { status: 'open' } },
        },
      });
      if (!submission) throw ApiError.notFound();

      const candidate = {
        sellerKycStatus: submission.seller.kycStatus as KycState,
        valueCheckStatus: submission.valueCheckStatus,
        authorizedPriceKobo: submission.authorizedPriceKobo,
        authorizationVersion: submission.authorizationVersion,
        sellerAcceptedPriceKobo: submission.sellerAcceptedPriceKobo,
        sellerAcceptedVersion: submission.sellerAcceptedVersion,
        categoryId: submission.categoryId,
        locationId: submission.locationId,
        photoCount: submission.photos.length,
        title: submission.title,
        description: submission.description,
        openFraudFlags: submission.fraudFlags.length,
        alreadyHasListing: submission.listing !== null,
      };

      if (!canPublish(candidate)) {
        throw ApiError.unprocessable('This submission is not ready to publish.', {
          gaps: publicationGaps(candidate),
        });
      }

      const hubSubmission = await prisma.declutterSubmission.findUniqueOrThrow({ where: { id }, include: hubInclude });
      const blockers = hubBlockers(facts(hubSubmission));
      if (blockers.length) throw ApiError.unprocessable('Mandatory item checks are still outstanding.', { blockers });

      // Narrowed by `canPublish`, but TypeScript cannot see that through a
      // boolean, and an assertion here would be the wrong kind of confidence.
      const price = submission.authorizedPriceKobo;
      const categoryId = submission.categoryId;
      const locationId = submission.locationId;
      const title = submission.title?.trim();
      const description = submission.description?.trim();
      if (!price || !categoryId || !locationId || !title || !description) {
        throw ApiError.unprocessable('This submission is not ready to publish.');
      }

      const slug = listingSlug(title, submission.code);

      const listing = await prisma.$transaction(async (tx) => {
        // Serialise publication with proposed-update submission. Recheck after
        // taking the row lock, so an update cannot slip past the readiness read.
        await tx.declutterSubmission.update({ where: { id }, data: { updatedAt: new Date() } });
        const current = await tx.declutterSubmission.findUniqueOrThrow({ where: { id }, include: hubInclude });
        const currentBlockers = hubBlockers(facts(current));
        if (currentBlockers.length || current.listing || current.contentRevision !== submission.contentRevision || current.authorizationVersion !== submission.authorizationVersion) throw ApiError.unprocessable('This item changed or is not ready to publish. Refresh the workspace.', { blockers: currentBlockers });
        const created = await tx.declutterListing.create({
          data: {
            slug,
            submissionId: submission.id,
            sellerId: submission.sellerId,
            categoryId,
            locationId,
            title,
            description,
            condition: submission.condition ?? 'good',
            priceKobo: price,
            attributes: submission.attributes,
            moderationStatus: 'approved',
            availability: 'available',
            publishedAt: new Date(),
            revision: 1,
            events: {
              create: {
                axis: 'moderation',
                fromStatus: 'draft',
                toStatus: 'approved',
                actorType: acting,
                actorId: actor.identityId,
                note: 'Published from submission.',
              },
            },
          },
        });

        // Photographs are re-pointed, not re-uploaded. The same object in the
        // same private bucket, now also reachable through the listing — so
        // publishing does not double the storage bill or risk a copy that
        // silently differs from the one that was reviewed.
        for (const photo of submission.photos) {
          await tx.declutterListingPhoto.create({
            data: {
              listingId: created.id,
              fingerprintId: photo.fingerprintId,
              storageKey: photo.storageKey,
              position: photo.position,
              role: photo.role,
              caption: photo.caption,
            },
          });
        }

        await tx.declutterSubmission.update({
          where: { id: submission.id },
          data: {
            status: 'published',
            events: {
              create: {
                fromStatus: submission.status,
                toStatus: 'published',
                actorType: acting,
                actorId: actor.identityId,
                note: `Listing ${created.slug}`,
              },
            },
          },
        });

        return created;
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'declutter.listing.published',
        resourceType: 'DeclutterListing',
        resourceId: listing.id,
        after: { slug: listing.slug, priceKobo: listing.priceKobo, submissionId: submission.id },
        ...auditContext(request),
      });

      // Publication is committed; the browser's retry endpoint uses the same claim.
      try {
        const customer = submission.seller.customerId ? await prisma.customer.findUnique({
          where: { id: submission.seller.customerId }, include: { identity: { select: { email: true } } },
        }) : null;
        const result = await notifyListingPublished(notificationEmail(prisma, app.services.email, listing.id), {
          sellerEmail: customer?.identity.email ?? null, sellerName: submission.seller.displayName,
          listingId: listing.id, slug: listing.slug, itemTitle: listing.title,
          publicWebUrl: app.services.config.PUBLIC_WEB_URL,
        });
        if (result.failed) request.log.warn({ failed: result.failed }, 'declutter listing-live notification failed');
      } catch {
        request.log.warn('declutter listing-live notification failed');
      }
      reply.code(201);
      return { listing: { id: listing.id, slug: listing.slug, priceKobo: listing.priceKobo } };
    },
  );

  // =========================================================================
  // Listing lifecycle
  // =========================================================================

  /** GET /v1/admin/declutter/listings — the operator's view, including hidden ones. */
  app.get(
    '/v1/admin/declutter/listings',
    { preHandler: requirePermission('declutter:listing:read') },
    async (request) => {
      const query = z
        .object({
          moderationStatus: z.string().trim().max(30).optional(),
          availability: z.string().trim().max(30).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .parse(request.query);

      const listings = await prisma.declutterListing.findMany({
        where: {
          ...(query.moderationStatus ? { moderationStatus: query.moderationStatus } : {}),
          ...(query.availability ? { availability: query.availability } : {}),
        },
        orderBy: { updatedAt: 'desc' },
        take: query.limit,
        include: {
          seller: { select: { displayName: true, kycStatus: true, sellerType: true } },
          category: { select: { key: true, name: true } },
          location: { select: { slug: true } },
          _count: { select: { contactRequests: true } },
        },
      });

      return {
        listings: listings.map((listing) => ({
          id: listing.id,
          slug: listing.slug,
          title: listing.title,
          priceKobo: listing.priceKobo,
          moderationStatus: listing.moderationStatus,
          availability: listing.availability,
          publishedAt: listing.publishedAt?.toISOString() ?? null,
          viewCount: listing.viewCount,
          contactRequests: listing._count.contactRequests,
          seller: listing.seller.displayName,
          category: listing.category.name,
          publiclyVisible: isPubliclyVisible(
            listing.moderationStatus as ModerationState,
            listing.availability as AvailabilityState,
          ),
        })),
      };
    },
  );

  /**
   * POST /v1/admin/declutter/listings/:id/moderation
   *
   * Approve, reject, suspend or send back for review. The machine decides which
   * moves are legal from here and who may make them; the permission opens the
   * route, and suspension additionally needs `declutter:listing:suspend`,
   * because taking a live page down is a different authority from approving
   * one.
   */
  app.post(
    '/v1/admin/declutter/listings/:id/moderation',
    { preHandler: requirePermission('declutter:listing:write') },
    async (request) => {
      const actor = actorOf(request);
      const acting = declutterActorFor(actor);
      const { id } = z.object({ id: z.string().min(1).max(40) }).parse(request.params);
      const body = moderationSchema.parse(request.body);

      const listing = await prisma.declutterListing.findUnique({ where: { id } });
      if (!listing) throw ApiError.notFound();

      if (body.to === 'suspended' && !actor.permissions.has('declutter:listing:suspend')) {
        throw ApiError.forbidden('You cannot suspend a listing.');
      }
      if (body.to === 'approved' && !actor.permissions.has('declutter:listing:publish')) {
        throw ApiError.forbidden('You cannot approve a listing.');
      }
      if ((body.to === 'rejected' || body.to === 'suspended') && !body.reason?.trim()) {
        // A refusal a seller cannot be told the reason for is not a decision,
        // it is a disappearance.
        throw ApiError.badRequest('Give a reason. The seller will be told it.');
      }

      const from = listing.moderationStatus as ModerationState;
      let to: ModerationState;
      try {
        to = moderationMachine.assert(from, body.to as ModerationState, acting);
      } catch (error) {
        if (error instanceof DeclutterTransitionError) {
          throw error.reason === 'actor_not_permitted'
            ? ApiError.forbidden('Your role cannot make that decision.')
            : ApiError.conflict(`A listing in ${from} cannot move to ${body.to}.`);
        }
        throw error;
      }

      const updated = await prisma.declutterListing.update({
        where: { id: listing.id },
        data: {
          moderationStatus: to,
          revision: { increment: 1 },
          rejectionReason: to === 'rejected' ? (body.reason ?? null) : listing.rejectionReason,
          suspensionReason: to === 'suspended' ? (body.reason ?? null) : listing.suspensionReason,
          suspendedAt: to === 'suspended' ? new Date() : listing.suspendedAt,
          events: {
            create: {
              axis: 'moderation',
              fromStatus: from,
              toStatus: to,
              actorType: acting,
              actorId: actor.identityId,
              note: body.reason ?? null,
            },
          },
        },
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: `declutter.listing.${to}`,
        resourceType: 'DeclutterListing',
        resourceId: listing.id,
        before: { moderationStatus: from },
        after: { moderationStatus: to, reason: body.reason ?? null },
        ...auditContext(request),
      });

      return {
        listing: { id: updated.id, moderationStatus: updated.moderationStatus, revision: updated.revision },
      };
    },
  );

  /** POST /v1/admin/declutter/listings/:id/availability — reserved, sold, withdrawn. */
  app.post(
    '/v1/admin/declutter/listings/:id/availability',
    { preHandler: requirePermission('declutter:listing:write') },
    async (request) => {
      const actor = actorOf(request);
      const acting = declutterActorFor(actor);
      const { id } = z.object({ id: z.string().min(1).max(40) }).parse(request.params);
      const body = availabilitySchema.parse(request.body);

      const listing = await prisma.declutterListing.findUnique({ where: { id } });
      if (!listing) throw ApiError.notFound();

      const from = listing.availability as AvailabilityState;
      let to: AvailabilityState;
      try {
        to = availabilityMachine.assert(from, body.to as AvailabilityState, acting);
      } catch (error) {
        if (error instanceof DeclutterTransitionError) {
          throw error.reason === 'actor_not_permitted'
            ? ApiError.forbidden('Your role cannot make that change.')
            : ApiError.conflict(`A listing that is ${from} cannot become ${body.to}.`);
        }
        throw error;
      }

      const updated = await prisma.declutterListing.update({
        where: { id: listing.id },
        data: {
          availability: to,
          revision: { increment: 1 },
          soldAt: to === 'sold' ? new Date() : listing.soldAt,
          events: {
            create: {
              axis: 'availability',
              fromStatus: from,
              toStatus: to,
              actorType: acting,
              actorId: actor.identityId,
              note: body.reason ?? null,
            },
          },
        },
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: `declutter.listing.availability.${to}`,
        resourceType: 'DeclutterListing',
        resourceId: listing.id,
        before: { availability: from },
        after: { availability: to },
        ...auditContext(request),
      });

      return { listing: { id: updated.id, availability: updated.availability, revision: updated.revision } };
    },
  );

  // =========================================================================
  // The public marketplace
  // =========================================================================

  /** GET /v1/declutter/taxonomy — the categories and areas a filter can offer. */
  app.get('/v1/declutter/taxonomy', async () => {
    const [categories, locations] = await Promise.all([
      prisma.declutterCategory.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: { key: true, name: true, slug: true },
      }),
      prisma.declutterLocation.findMany({
        where: { isActive: true, kind: 'area' },
        orderBy: { sortOrder: 'asc' },
        select: { slug: true },
      }),
    ]);

    return {
      categories,
      // Shaped by `publicLocation`, whose return type has no coordinate, no
      // address and no delivery estimate on it.
      locations: locations
        .map((location) => publicLocation(location.slug))
        .filter((location): location is NonNullable<typeof location> => location !== null),
    };
  });

  /**
   * GET /v1/declutter/listings — the feed.
   *
   * Unauthenticated. Filtering is server-side and the visibility predicate is
   * not a parameter: `moderationStatus: 'approved'` with an available or
   * reserved availability is written into the `where` on every path, so no
   * combination of query values can reach a draft, rejected or suspended
   * listing.
   */
  app.get('/v1/declutter/listings', async (request) => {
    const query = listQuerySchema.parse(request.query);

    if (
      query.minPriceKobo !== undefined &&
      query.maxPriceKobo !== undefined &&
      query.minPriceKobo > query.maxPriceKobo
    ) {
      throw ApiError.badRequest('The lowest price is above the highest.');
    }

    const where = {
      // Not negotiable, and not derived from anything the caller sent.
      moderationStatus: 'approved',
      availability: { in: ['available', 'reserved'] },
      ...(query.category ? { category: { key: query.category } } : {}),
      ...(query.location ? { location: { slug: query.location } } : {}),
      ...(query.condition ? { condition: query.condition } : {}),
      ...(query.minPriceKobo !== undefined || query.maxPriceKobo !== undefined
        ? {
            priceKobo: {
              ...(query.minPriceKobo !== undefined ? { gte: query.minPriceKobo } : {}),
              ...(query.maxPriceKobo !== undefined ? { lte: query.maxPriceKobo } : {}),
            },
          }
        : {}),
      ...(query.q
        ? {
            // Title and description only. Searching attributes would let a
            // crafted query probe for an admin-only value such as a serial
            // number by testing whether a result comes back.
            OR: [
              { title: { contains: query.q } },
              { description: { contains: query.q } },
            ],
          }
        : {}),
    };

    const orderBy: Record<ListingSort, { publishedAt?: 'desc'; priceKobo?: 'asc' | 'desc' }> = {
      newest: { publishedAt: 'desc' },
      price_low: { priceKobo: 'asc' },
      price_high: { priceKobo: 'desc' },
    };

    const rows = await prisma.declutterListing.findMany({
      where,
      // One more than asked for, to learn whether another page exists without
      // a second count query over the whole table.
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [orderBy[query.sort], { id: 'desc' }],
      include: {
        seller: { select: { kycStatus: true, sellerType: true } },
        category: { select: { key: true, name: true } },
        location: { select: { slug: true } },
        photos: { orderBy: { position: 'asc' }, take: 1 },
      },
    });

    const page = rows.slice(0, query.limit);
    const nextCursor = rows.length > query.limit ? (page.at(-1)?.id ?? null) : null;

    return {
      listings: await Promise.all(
        page.map(async (listing) => {
          const photo = listing.photos[0];
          return {
            slug: listing.slug,
            title: listing.title,
            priceKobo: listing.priceKobo,
            condition: listing.condition,
            categoryKey: listing.category.key,
            categoryName: listing.category.name,
            location: publicLocation(listing.location.slug) ?? {
              slug: listing.location.slug,
              label: listing.location.slug,
            },
            availability: listing.availability,
            badges: badgesFor(listing),
            photo: photo ? await signedPhoto(photo, listing.title) : null,
            publishedAt: listing.publishedAt?.toISOString() ?? null,
          };
        }),
      ),
      nextCursor,
    };
  });

  /**
   * GET /v1/declutter/listings/:slug — one item.
   *
   * A hidden listing is a 404, not a 403. A 403 would confirm that a slug
   * someone guessed, or a listing that was suspended for fraud, exists.
   */
  app.get('/v1/declutter/listings/:slug', async (request) => {
    const { slug } = z.object({ slug: z.string().min(1).max(120) }).parse(request.params);

    const listing = await prisma.declutterListing.findUnique({
      where: { slug },
      include: {
        seller: {
          select: {
            id: true,
            displayName: true,
            sellerType: true,
            kycStatus: true,
            createdAt: true,
          },
        },
        category: { select: { key: true, name: true } },
        location: { select: { slug: true } },
        photos: { orderBy: { position: 'asc' } },
      },
    });

    if (
      !listing ||
      !isPubliclyVisible(
        listing.moderationStatus as ModerationState,
        listing.availability as AvailabilityState,
      )
    ) {
      throw ApiError.notFound();
    }

    // Fire-and-forget: a view counter must never be able to fail a page. The
    // count is a product signal, not a ledger.
    void prisma.declutterListing
      .update({ where: { id: listing.id }, data: { viewCount: { increment: 1 } } })
      .catch(() => undefined);

    const stored = listing.attributes
      ? (JSON.parse(listing.attributes) as Record<string, unknown>)
      : {};

    return {
      listing: {
        slug: listing.slug,
        title: listing.title,
        description: listing.description,
        priceKobo: listing.priceKobo,
        condition: listing.condition,
        categoryKey: listing.category.key,
        categoryName: listing.category.name,
        location: publicLocation(listing.location.slug) ?? {
          slug: listing.location.slug,
          label: listing.location.slug,
        },
        availability: listing.availability,
        badges: badgesFor(listing),
        // The same allowlist the valuation path uses. An IMEI or a serial
        // number is `visibility: 'admin'` in the taxonomy and is dropped here,
        // which is the difference between recording ownership evidence and
        // publishing everything a thief needs.
        attributes: publicAttributes(listing.category.key, stored),
        photos: await Promise.all(
          listing.photos.map((photo) => signedPhoto(photo, listing.title)),
        ),
        seller: {
          id: listing.seller.id,
          displayName: listing.seller.displayName,
          sellerType: listing.seller.sellerType,
          isTrustedPartner: listing.seller.sellerType === 'trusted_partner',
          memberSince: listing.seller.createdAt.toISOString(),
        },
        contactable: isPubliclyActionable(
          listing.moderationStatus as ModerationState,
          listing.availability as AvailabilityState,
        ),
        publishedAt: listing.publishedAt?.toISOString() ?? null,
      },
    };
  });

  // =========================================================================
  // Contact requests
  // =========================================================================

  /**
   * POST /v1/declutter/listings/:slug/contact-requests
   *
   * A buyer asking to be put in touch. Authenticated, because an introduction
   * to a real person is not something an anonymous caller gets to request, and
   * because the record has to name who asked.
   *
   * Creating one reveals nothing. It is a queued question for a human.
   */
  app.post(
    '/v1/declutter/listings/:slug/contact-requests',
    { preHandler: requireAuth },
    async (request, reply) => {
      const actor = actorOf(request);
      const customerId = customerIdOf(actor);
      const { slug } = z.object({ slug: z.string().min(1).max(120) }).parse(request.params);
      const body = contactRequestSchema.parse(request.body);

      const listing = await prisma.declutterListing.findUnique({
        where: { slug },
        include: { seller: { select: { id: true, customerId: true } } },
      });
      if (
        !listing ||
        !isPubliclyVisible(
          listing.moderationStatus as ModerationState,
          listing.availability as AvailabilityState,
        )
      ) {
        throw ApiError.notFound();
      }
      if (
        !isPubliclyActionable(
          listing.moderationStatus as ModerationState,
          listing.availability as AvailabilityState,
        )
      ) {
        throw ApiError.conflict('This item is reserved. It is not available to enquire about.');
      }
      if (listing.seller.customerId === customerId) {
        throw ApiError.badRequest('This is your own listing.');
      }

      // One open request per buyer per listing. Without this, a buyer refreshing
      // an unanswered form fills a human's queue with the same question.
      const existing = await prisma.declutterContactRequest.findFirst({
        where: { listingId: listing.id, buyerCustomerId: customerId, status: 'pending' },
      });
      if (existing) {
        throw ApiError.conflict('You have already asked about this item. DASH will come back to you.');
      }

      const created = await prisma.declutterContactRequest.create({
        data: {
          listingId: listing.id,
          buyerCustomerId: customerId,
          status: 'pending',
          message: body.message ?? null,
        },
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'declutter.contact.requested',
        resourceType: 'DeclutterContactRequest',
        resourceId: created.id,
        after: { listingId: listing.id },
        ...auditContext(request),
      });

      reply.code(201);
      return { contactRequest: { id: created.id, status: created.status } };
    },
  );

  /** GET /v1/declutter/contact-requests — the caller's own enquiries. */
  app.get('/v1/declutter/contact-requests', { preHandler: requireAuth }, async (request) => {
    const customerId = customerIdOf(actorOf(request));
    const rows = await prisma.declutterContactRequest.findMany({
      where: { buyerCustomerId: customerId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { listing: { select: { slug: true, title: true } } },
    });

    return {
      contactRequests: rows.map((row) => ({
        id: row.id,
        status: row.status,
        // The method, never the detail. What was actually disclosed reaches a
        // buyer through the relay, not through a list endpoint.
        grantedMethod: row.grantedMethod,
        listing: row.listing,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  });

  /** GET /v1/admin/declutter/contact-requests — the review queue. */
  app.get(
    '/v1/admin/declutter/contact-requests',
    { preHandler: requirePermission('declutter:contact:review') },
    async (request) => {
      const query = z
        .object({
          status: z.string().trim().max(20).default('pending'),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .parse(request.query);

      const rows = await prisma.declutterContactRequest.findMany({
        where: { status: query.status },
        orderBy: { createdAt: 'asc' },
        take: query.limit,
        include: {
          listing: { select: { slug: true, title: true, priceKobo: true } },
          buyer: { select: { id: true } },
        },
      });

      return {
        contactRequests: rows.map((row) => ({
          id: row.id,
          status: row.status,
          message: row.message,
          listing: row.listing,
          buyerCustomerId: row.buyer.id,
          createdAt: row.createdAt.toISOString(),
        })),
      };
    },
  );

  /**
   * POST /v1/admin/declutter/contact-requests/:id/decision
   *
   * Approve or refuse an introduction.
   *
   * The default method is `dash_relay`, in which nothing about the seller
   * leaves the platform. A direct method — handing a buyer a real phone or
   * WhatsApp number — needs a separate, step-up-gated permission *and* recorded
   * seller consent, because consent to DASH mediating is implied by listing and
   * consent to giving a stranger your personal number is not.
   *
   * Every approval writes a disclosure row. That table is append-only and has
   * no `revokedAt`, because revoking a direct disclosure closes the app's door
   * and nothing else: the number is already in someone's phone.
   */
  app.post(
    '/v1/admin/declutter/contact-requests/:id/decision',
    { preHandler: requirePermission('declutter:contact:review') },
    async (request) => {
      const actor = actorOf(request);
      const acting = declutterActorFor(actor);
      const { id } = z.object({ id: z.string().min(1).max(40) }).parse(request.params);
      const body = contactDecisionSchema.parse(request.body);

      const contactRequest = await prisma.declutterContactRequest.findUnique({
        where: { id },
        include: { listing: { select: { id: true, sellerId: true } } },
      });
      if (!contactRequest) throw ApiError.notFound();

      const from = contactRequest.status as ContactRequestState;
      let to: ContactRequestState;
      try {
        to = contactRequestMachine.assert(from, body.decision as ContactRequestState, acting);
      } catch (error) {
        if (error instanceof DeclutterTransitionError) {
          throw error.reason === 'actor_not_permitted'
            ? ApiError.forbidden('Your role cannot make that decision.')
            : ApiError.conflict(`A ${from} request cannot become ${body.decision}.`);
        }
        throw error;
      }

      if (to === 'rejected') {
        if (!body.reason?.trim()) throw ApiError.badRequest('Give a reason.');

        const updated = await prisma.declutterContactRequest.update({
          where: { id: contactRequest.id },
          data: {
            status: to,
            decidedBy: actor.identityId,
            decidedAt: new Date(),
            rejectionReason: body.reason,
          },
        });

        await writeAudit(prisma, {
          identityId: actor.identityId,
          action: 'declutter.contact.rejected',
          resourceType: 'DeclutterContactRequest',
          resourceId: contactRequest.id,
          after: { reason: body.reason },
          ...auditContext(request),
        });

        return { contactRequest: { id: updated.id, status: updated.status } };
      }

      const method = (body.method ?? DEFAULT_CONTACT_METHOD) as ContactMethod;

      if (!isMediatedContact(method)) {
        if (!actor.permissions.has('declutter:contact:disclose:direct')) {
          throw ApiError.forbidden(
            'You cannot hand out a seller’s direct contact details. Approve a DASH relay instead.',
          );
        }
        if (requiresSellerConsent(method) && !body.sellerConsentEvidence?.trim()) {
          throw ApiError.badRequest(
            'Record the seller’s consent before releasing their direct contact details.',
          );
        }
      }
      if (requiresApprovalReason(method) && !body.reason?.trim()) {
        throw ApiError.badRequest('Give a reason for releasing direct contact details.');
      }

      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.declutterContactRequest.update({
          where: { id: contactRequest.id },
          data: {
            status: to,
            grantedMethod: method,
            decidedBy: actor.identityId,
            decidedAt: new Date(),
            decisionNote: body.reason ?? null,
          },
        });

        await tx.declutterContactDisclosure.create({
          data: {
            contactRequestId: contactRequest.id,
            listingId: contactRequest.listing.id,
            sellerId: contactRequest.listing.sellerId,
            buyerCustomerId: contactRequest.buyerCustomerId,
            method,
            // Empty for a mediated introduction, because nothing was revealed.
            disclosedFields: JSON.stringify(disclosedFieldsFor(method)),
            approvedBy: actor.identityId,
            approvalReason: body.reason ?? null,
            ...(body.sellerConsentEvidence
              ? { sellerConsentAt: new Date(), sellerConsentEvidence: body.sellerConsentEvidence }
              : {}),
          },
        });

        return row;
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'declutter.contact.approved',
        resourceType: 'DeclutterContactRequest',
        resourceId: contactRequest.id,
        after: { method, mediated: isMediatedContact(method) },
        ...auditContext(request),
      });

      return { contactRequest: { id: updated.id, status: updated.status, grantedMethod: method } };
    },
  );
}
