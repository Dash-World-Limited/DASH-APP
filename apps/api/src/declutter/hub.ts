import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  hubBlockers,
  hubProgress,
  hubStatus,
  HUB_BLOCKER_LABELS,
  publicAttributes,
  type HubFacts,
} from '@dash/domain/declutter';
import { dashEmailHtml } from '../email/dash-brand.js';
import { notificationEmail } from './notification-delivery.js';

export const hubInclude = {
  seller: { include: { customer: { include: { identity: true } } } },
  category: true,
  photos: { orderBy: { position: 'asc' as const } },
  listing: true,
  valuations: {
    where: { status: 'succeeded' },
    orderBy: { createdAt: 'desc' as const },
    take: 1,
  },
  fraudFlags: { where: { status: { in: ['open', 'reviewing', 'upheld'] } } },
  updates: {
    orderBy: { createdAt: 'desc' as const },
    include: { photos: { orderBy: { position: 'asc' as const } } },
    take: 10,
  },
  events: { orderBy: { createdAt: 'asc' as const } },
} satisfies Prisma.DeclutterSubmissionInclude;
export type HubRow = Prisma.DeclutterSubmissionGetPayload<{
  include: typeof hubInclude;
}>;
export function facts(s: HubRow): HubFacts {
  return {
    ...s,
    sellerKycStatus: s.seller.kycStatus as HubFacts['sellerKycStatus'],
    photoCount: s.photos.length,
    openFraudFlags: s.fraudFlags.length,
    alreadyHasListing: Boolean(s.listing),
    pendingUpdate: s.updates.some((u) => u.status === 'pending'),
    valuationAt: s.valuations[0]?.createdAt ?? null,
    sellerVerifiedAt: s.seller.verifiedAt,
    availability: s.listing?.availability ?? null,
    moderationStatus: s.listing?.moderationStatus ?? null,
    publishedAt:
      s.listing?.moderationStatus === 'approved' &&
      ['available', 'reserved'].includes(s.listing.availability)
        ? s.listing.publishedAt
        : null,
  };
}
export async function hubView(app: FastifyInstance, s: HubRow) {
  const f = facts(s);
  const conversations =
    await app.services.prisma.declutterConversation.findMany({
      where: {
        submissionId: s.id,
        sellerIdentityId: s.seller.customer?.identityId,
      },
      select: { id: true },
    });
  const unreadCount = await app.services.prisma.declutterMessage.count({
    where: {
      conversationId: { in: conversations.map((c) => c.id) },
      senderType: 'staff',
      readAt: null,
    },
  });
  const location = s.locationId
    ? await app.services.prisma.declutterLocation.findUnique({
        where: { id: s.locationId },
        select: { name: true },
      })
    : null;
  const progress = hubProgress(f);
  const history = progress
    .filter((p) => p.state === 'completed' && p.at)
    .map((p) => ({
      label:
        p.label === 'DASH price decision'
          ? `DASH authorised ${money(s.authorizedPriceKobo)}`
          : p.label === 'Seller price decision'
            ? `Seller accepted ${money(s.sellerAcceptedPriceKobo)}`
            : p.label,
      at: p.at!,
    }));
  history.push({
    label: `Submitted price — ${money(s.expectedPriceKobo)}`,
    at: s.createdAt,
  });
  if (s.valueCheckStatus === 'seller_declined' && s.sellerDeclinedAt)
    history.push({
      label: 'Seller declined the authorised price',
      at: s.sellerDeclinedAt,
    });
  if (s.valueCheckStatus === 'seller_acceptance_pending' && s.authorizedAt)
    history.push({
      label: 'Waiting for your price decision',
      at: s.authorizedAt,
    });
  const eventLabels: Record<string, string> = {
    details_pending: 'DASH requested more information',
    rejected: 'Item not approved',
    withdrawn: 'Item withdrawn',
    update_submitted: 'Seller submitted an item update',
    update_approved: 'Item update approved',
    update_rejected: 'Item update not approved',
    update_changes_requested: 'Changes requested on item update',
    seller_declined: 'Seller declined the authorised price',
  };
  for (const e of s.events)
    if (eventLabels[e.toStatus])
      history.push({ label: eventLabels[e.toStatus]!, at: e.createdAt });
  const priceAction = s.valueCheckStatus === 'seller_acceptance_pending';
  const actions = [
    ...(priceAction
      ? [
          {
            label: 'Price decision required',
            cta: 'Review price',
            href: '#price',
          },
        ]
      : []),
    ...(['unverified', 'rejected', 'suspended'].includes(s.seller.kycStatus)
      ? [
          {
            label: 'Seller verification required',
            cta: 'Review verification',
            href:
              s.seller.kycStatus === 'suspended'
                ? '/declutter/account/messages'
                : '/declutter/seller/verify',
          },
        ]
      : []),
    ...(unreadCount
      ? [
          {
            label: `${unreadCount} new message${unreadCount === 1 ? '' : 's'} from DASH`,
            cta: 'View messages',
            href: '#chat',
          },
        ]
      : []),
    ...(s.status === 'details_pending' ||
    s.updates[0]?.status === 'changes_requested'
      ? [
          {
            label: 'Additional information requested',
            cta: 'Update item',
            href: '#edit',
          },
        ]
      : []),
  ];
  return {
    id: s.id,
    code: s.code,
    title: s.title,
    description: s.description,
    condition: s.condition,
    category: s.category?.name ?? null,
    location: location?.name ?? null,
    attributes: publicAttributes(
      s.category?.key ?? '',
      s.attributes ? JSON.parse(s.attributes) : {},
    ),
    createdAt: s.createdAt,
    status: hubStatus(f),
    valueCheckStatus: s.valueCheckStatus,
    expectedPriceKobo: s.expectedPriceKobo,
    authorizedPriceKobo: s.authorizedPriceKobo,
    priceAcceptanceValid:
      progress.find((p) => p.key === 'seller_price')?.state === 'completed',
    preConsented: Boolean(
      s.submittedPriceConsentAt &&
        s.submittedPriceConsentBy === s.seller.customer?.identityId &&
        s.submittedPriceConsentKobo === s.expectedPriceKobo,
    ),
    seller: { name: s.seller.displayName, kycStatus: s.seller.kycStatus },
    listing: s.listing
      ? {
          slug: s.listing.slug,
          priceKobo: s.listing.priceKobo,
          publishedAt: f.publishedAt,
          availability: s.listing.availability,
        }
      : null,
    progress,
    history: history.sort(
      (a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0),
    ),
    unreadCount,
    conversationId: conversations[0]?.id ?? null,
    actions,
    blockers: hubBlockers(f).map(
      (code) => HUB_BLOCKER_LABELS[code] ?? 'DASH review is required',
    ),
    next:
      actions[0]?.label ??
      (f.publishedAt
        ? 'Your item is live. You can contact DASH or submit an update.'
        : !hubBlockers(f).length
          ? 'All checks have passed. DASH can give final approval and publish your item.'
          : s.valueCheckStatus === 'seller_declined'
            ? 'You declined the price. Chat with DASH to discuss the next step.'
            : 'DASH is reviewing your item. No action is required from you.'),
    photos: await Promise.all(
      s.photos.map(async (p) => ({
        id: p.id,
        url: await app.services.storage.signedUrl(p.storageKey, 3600),
        role: p.role,
        caption: p.caption,
      })),
    ),
    updates: await Promise.all(
      s.updates.map(async (u) => ({
        id: u.id,
        status: u.status,
        title: u.title,
        description: u.description,
        condition: u.condition,
        sellerMessage: u.sellerMessage,
        submittedAt: u.submittedAt,
        reviewedAt: u.reviewedAt,
        photos: await Promise.all(
          u.photos.map(async (p) => ({
            id: p.id,
            url: await app.services.storage.signedUrl(p.storageKey, 3600),
            role: p.role,
          })),
        ),
      })),
    ),
  };
}
export function money(price: number | null) {
  return price === null
    ? 'Not set'
    : new Intl.NumberFormat('en-NG', {
        style: 'currency',
        currency: 'NGN',
      }).format(price / 100);
}

/** Mutations reconcile recorded facts. Reads and page navigation never advance state. */
export async function reconcileHub(prisma: PrismaClient, id: string) {
  const s = await prisma.declutterSubmission.findUnique({
    where: { id },
    include: hubInclude,
  });
  if (!s) return;
  const f = facts(s);
  const status =
    s.fullyApprovedAt && !hubBlockers(f).length
      ? 'approved'
      : s.seller.kycStatus !== 'verified'
        ? 'kyc_pending'
        : s.fraudFlags.length || !s.safetyReviewedAt
          ? 'fraud_review'
          : !s.itemReviewedAt
            ? 'intake'
            : !s.valuations.length
              ? 'valuation_pending'
              : s.valueCheckStatus === 'seller_acceptance_pending'
                ? 'seller_acceptance_pending'
                : 'pricing_review';
  if (
    !['published', 'rejected', 'withdrawn', 'details_pending'].includes(
      s.status,
    ) &&
    s.status !== status
  )
    await prisma.declutterSubmission.update({
      where: { id },
      data: { status },
    });
  if (
    s.valueCheckStatus === 'seller_acceptance_pending' &&
    s.authorizedPriceKobo &&
    s.seller.customer?.identityId
  ) {
    const eventKey = `price:${s.id}:${s.authorizationVersion}`;
    await prisma.declutterHubNotification.upsert({
      where: { eventKey },
      create: {
        eventKey,
        kind: 'price',
        submissionId: id,
        recipientIdentityId: s.seller.customer.identityId,
      },
      update: {},
    });
  }
}
const delivering = new WeakSet<FastifyInstance>();
export async function deliverHubNotifications(app: FastifyInstance) {
  if (delivering.has(app)) return;
  delivering.add(app);
  try {
    const { prisma, email, config } = app.services;
    const pending = await prisma.declutterHubNotification.findMany({
      where: { deliveredAt: null },
      orderBy: { createdAt: 'asc' },
      take: 30,
    });
    for (const n of pending) {
      try {
        const identity = await prisma.identity.findUnique({
          where: { id: n.recipientIdentityId },
          select: { email: true, displayName: true },
        });
        const s = n.submissionId
          ? await prisma.declutterSubmission.findUnique({
              where: { id: n.submissionId },
            })
          : null;
        const message = n.messageId
          ? await prisma.declutterMessage.findUnique({
              where: { id: n.messageId },
            })
          : null;
        const obsolete =
          !identity?.email ||
          (n.kind === 'price' &&
            (!s ||
              s.valueCheckStatus !== 'seller_acceptance_pending' ||
              n.eventKey !== `price:${s.id}:${s.authorizationVersion}`)) ||
          (n.kind === 'message' && (!message || message.readAt));
        if (!obsolete && identity?.email) {
          const href = `${config.PUBLIC_WEB_URL.replace(/\/$/, '')}${s ? `/declutter/account/items/${encodeURIComponent(s.id)}` : '/declutter/account/messages'}${n.kind === 'message' ? '#chat' : '#price'}`;
          const title =
            n.kind === 'price'
              ? 'Your DASH price is ready — review your item'
              : 'DASH sent you a message';
          const details = [
            { label: 'Item', value: s?.title ?? 'Account support' },
            { label: 'Reference', value: s?.code ?? 'DASH Declutters' },
            ...(n.kind === 'price' && s
              ? [
                  {
                    label: 'Your submitted price',
                    value: money(s.expectedPriceKobo),
                  },
                  {
                    label: 'DASH authorised price',
                    value: money(s.authorizedPriceKobo),
                  },
                ]
              : []),
          ];
          const preview =
            n.kind === 'price'
              ? 'Your price decision is required before this item can proceed.'
              : `New message: ${(message?.body ?? '').slice(0, 120)}`;
          await notificationEmail(prisma, email, n.eventKey).send({
            to: identity.email,
            subject: title,
            text: `Hello ${identity.displayName ?? 'there'},\n\n${preview}\n${details.map((d) => `${d.label}: ${d.value}`).join('\n')}\n\n${href}`,
            html: dashEmailHtml({
              title,
              previewText: title,
              eyebrow: 'DASH Declutters',
              greeting: `Hello ${identity.displayName ?? 'there'},`,
              paragraphs: [preview],
              details,
              cta: {
                label:
                  n.kind === 'price'
                    ? 'Review & approve price'
                    : 'View message',
                href,
              },
            }),
            reference: n.eventKey,
          });
        }
        await prisma.declutterHubNotification.update({
          where: { id: n.id },
          data: { deliveredAt: new Date(), attempts: { increment: 1 } },
        });
      } catch {
        await app.services.prisma.declutterHubNotification.update({
          where: { id: n.id },
          data: { attempts: { increment: 1 } },
        });
      }
    }
  } finally {
    delivering.delete(app);
  }
}
