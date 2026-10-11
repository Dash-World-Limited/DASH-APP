import type { FastifyInstance } from 'fastify';
import type { Prisma, DeclutterListing } from '@prisma/client';
import { writeAudit } from '@dash/db';
import {
  hubBlockers,
  listingSlug,
  publicationGaps,
} from '@dash/domain/declutter';
import { facts, hubInclude, type HubRow } from './hub.js';
import { ApiError } from '../http/errors.js';
import type { auditContext } from '../routes/declutter-shared.js';
import { notifyListingPublished } from './notifications.js';
import { notificationEmail } from './notification-delivery.js';

/** One snapshot publisher for normal publication and the final Super Admin action.
 * The caller holds the submission row lock. It never overwrites an existing ad.
 */
export async function publishSnapshot(
  tx: Prisma.TransactionClient,
  s: HubRow,
  identityId: string,
  actorType: 'admin' | 'super_admin',
  finalDecision = false,
  context: ReturnType<typeof auditContext> = {},
) {
  const f = facts(s);
  const blockers = finalDecision
    ? [
        ...publicationGaps({ ...f, alreadyHasListing: false }),
        ...(['withdrawn', 'rejected'].includes(s.status)
          ? ['item_paused']
          : []),
      ]
    : hubBlockers(f);
  if (blockers.length || s.listing)
    throw ApiError.unprocessable('This item is not ready to publish.', {
      blockers,
    });
  const priceKobo = s.authorizedPriceKobo;
  if (
    !priceKobo ||
    !s.categoryId ||
    !s.locationId ||
    !s.title?.trim() ||
    !s.description?.trim()
  )
    throw ApiError.unprocessable(
      'Complete the item details before publication.',
    );
  const listing = await tx.declutterListing.create({
    data: {
      slug: listingSlug(s.title, s.code),
      submissionId: s.id,
      sellerId: s.sellerId,
      categoryId: s.categoryId,
      locationId: s.locationId,
      title: s.title.trim(),
      description: s.description.trim(),
      condition: s.condition ?? 'good',
      priceKobo,
      attributes: s.attributes,
      moderationStatus: 'approved',
      availability: 'available',
      publishedAt: new Date(),
      revision: 1,
      events: {
        create: {
          axis: 'moderation',
          fromStatus: 'draft',
          toStatus: 'approved',
          actorType,
          actorId: identityId,
          note: 'Published from submission.',
        },
      },
      photos: {
        create: s.photos.map((p) => ({
          fingerprintId: p.fingerprintId,
          storageKey: p.storageKey,
          position: p.position,
          role: p.role,
          caption: p.caption,
        })),
      },
    },
  });
  await tx.declutterSubmission.update({
    where: { id: s.id },
    data: {
      status: 'published',
      events: {
        create: {
          fromStatus: s.status,
          toStatus: 'published',
          actorType,
          actorId: identityId,
          note: `Listing ${listing.slug}`,
        },
      },
    },
  });
  await writeAudit(tx, {
    identityId,
    action: 'declutter.listing.published',
    resourceType: 'DeclutterListing',
    resourceId: listing.id,
    after: { slug: listing.slug, priceKobo, submissionId: s.id },
    ...context,
  });
  return listing;
}

/** Delivery is after commit, uses the existing durable listing-specific claim. */
export async function sendPublicationEmail(
  app: FastifyInstance,
  listing: DeclutterListing,
) {
  try {
    const seller = await app.services.prisma.declutterSeller.findUniqueOrThrow({
      where: { id: listing.sellerId },
      include: { customer: { include: { identity: true } } },
    });
    const result = await notifyListingPublished(
      notificationEmail(app.services.prisma, app.services.email, listing.id),
      {
        sellerEmail: seller.customer?.identity.email ?? null,
        sellerName: seller.displayName,
        listingId: listing.id,
        slug: listing.slug,
        itemTitle: listing.title,
        publicWebUrl: app.services.config.PUBLIC_WEB_URL,
      },
    );
    if (result.failed)
      app.log.warn(
        { failed: result.failed },
        'declutter listing-live notification failed',
      );
  } catch {
    app.log.warn('declutter listing-live notification failed');
  }
}

/** Seller acceptance / verification can fulfil a previously recorded final decision.
 * No GET or page navigation calls this. New risk flags still block publication.
 */
export async function publishRecordedDecision(
  app: FastifyInstance,
  id: string,
  context: ReturnType<typeof auditContext> = {},
) {
  const listing = await app.services.prisma.$transaction(async (tx) => {
    await tx.declutterSubmission.update({
      where: { id },
      data: { updatedAt: new Date() },
    });
    const s = await tx.declutterSubmission.findUniqueOrThrow({
      where: { id },
      include: hubInclude,
    });
    if (
      !s.fullyApprovedAt ||
      !s.fullyApprovedBy ||
      s.listing ||
      ['withdrawn', 'rejected', 'details_pending'].includes(s.status)
    )
      return null;
    if (publicationGaps({ ...facts(s), alreadyHasListing: false }).length)
      return null;
    return publishSnapshot(
      tx,
      s,
      s.fullyApprovedBy,
      'super_admin',
      true,
      context,
    );
  });
  if (listing) await sendPublicationEmail(app, listing);
}
