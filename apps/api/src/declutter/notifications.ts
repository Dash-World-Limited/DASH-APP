import type { PrismaClient } from '@prisma/client';
import type { EmailPort } from '@dash/domain/ports';
import { dashEmailHtml } from '../email/dash-brand.js';
import { notificationEmail } from './notification-delivery.js';

/**
 * Two independent inboxes on purpose. Declutters review must not depend on one
 * mailbox/provider being healthy at the exact moment a seller submits.
 */
export const DECLUTTER_ADMIN_EMAILS = [
  'dashdeclutter@gmail.com',
  'declutter@dashworldng.com',
] as const;

interface SendResult {
  attempted: number;
  failed: number;
}

async function settle(
  email: EmailPort,
  messages: readonly Parameters<EmailPort['send']>[0][],
): Promise<SendResult> {
  const results = await Promise.allSettled(messages.map((message) => email.send(message)));
  return {
    attempted: results.length,
    failed: results.filter((result) => result.status === 'rejected' || !result.value.accepted).length,
  };
}

function baseUrl(publicWebUrl: string): string {
  return publicWebUrl.replace(/\/$/, '');
}

function reviewUrl(publicWebUrl: string): string {
  return `${baseUrl(publicWebUrl)}/ops/declutter`;
}

function sellerVerifyUrl(publicWebUrl: string): string {
  return `${baseUrl(publicWebUrl)}/declutter/seller/verify`;
}

export async function notifySellerVerificationSubmitted(
  email: EmailPort,
  input: {
    sellerEmail: string | null;
    sellerName: string;
    sellerId: string;
    publicWebUrl: string;
  },
): Promise<SendResult> {
  const messages: Parameters<EmailPort['send']>[0][] = [];

  if (input.sellerEmail) {
    messages.push({
      to: input.sellerEmail,
      subject: 'We received your DASH Declutters verification',
      text: `Hello ${input.sellerName},\n\nThank you. Your seller verification has been received and is now waiting for DASH review.\n\nYou can continue submitting items while we review it. Nothing can go live until your seller profile is approved.\n\nDASH Declutters`,
      html: dashEmailHtml({
        previewText: 'Your DASH Declutters seller verification has been received.',
        eyebrow: 'DASH Declutters',
        greeting: `Hello ${input.sellerName},`,
        title: 'Verification received',
        paragraphs: [
          'Thank you. Your seller verification has been received and is now waiting for DASH review.',
          'You can continue submitting items while we review it. Nothing can go live until your seller profile is approved.',
        ],
        cta: { label: 'Back to selling', href: `${baseUrl(input.publicWebUrl)}/declutter/sell` },
      }),
      reference: `declutter_kyc_received_${input.sellerId}`,
    });
  }

  for (const adminEmail of DECLUTTER_ADMIN_EMAILS) {
    messages.push({
      to: adminEmail,
      subject: `Seller verification waiting — ${input.sellerName}`,
      text: `A DASH Declutters seller submitted verification.\n\nSeller: ${input.sellerName}\nSeller ID: ${input.sellerId}\n\nReview securely in DASH Ops: ${reviewUrl(input.publicWebUrl)}`,
      html: dashEmailHtml({
        previewText: `${input.sellerName} submitted seller verification.`,
        eyebrow: 'Declutters review',
        title: 'Seller verification waiting',
        paragraphs: ['A seller has submitted identity details and a private government-ID document for review.'],
        details: [
          { label: 'Seller', value: input.sellerName },
          { label: 'Seller ID', value: input.sellerId },
        ],
        cta: { label: 'Open secure review queue', href: reviewUrl(input.publicWebUrl) },
        securityNote: 'Identity documents are never attached to email. Open them only inside the authenticated DASH Ops review screen.',
      }),
      reference: `declutter_admin_kyc_${input.sellerId}`,
    });
  }

  return settle(email, messages);
}

export async function notifyDeclutterSubmissionCreated(
  email: EmailPort,
  input: {
    sellerEmail: string | null;
    sellerName: string;
    sellerId: string;
    kycStatus: string;
    submissionId: string;
    submissionCode: string;
    itemTitle: string;
    publicWebUrl: string;
  },
): Promise<SendResult> {
  const messages: Parameters<EmailPort['send']>[0][] = [];
  const needsVerification = input.kycStatus !== 'verified';

  if (input.sellerEmail) {
    messages.push({
      to: input.sellerEmail,
      subject: `We received your ${input.itemTitle} listing`,
      text: `Hello ${input.sellerName},\n\nThank you for listing ${input.itemTitle} with DASH Declutters.\n\nReference: ${input.submissionCode}\nStatus: ${needsVerification ? 'Waiting for seller verification' : 'Waiting for DASH review'}\n\n${needsVerification ? `Verify your seller profile here: ${sellerVerifyUrl(input.publicWebUrl)}\n\n` : ''}Nothing is published until DASH reviews the item and you agree to the final price.\n\nDASH Declutters`,
      html: dashEmailHtml({
        previewText: `DASH received your ${input.itemTitle} listing.`,
        eyebrow: 'DASH Declutters',
        greeting: `Hello ${input.sellerName},`,
        title: 'Your item is with us',
        paragraphs: [
          `Thank you for listing ${input.itemTitle} with DASH Declutters.`,
          'Nothing is published until DASH reviews the item and you agree to the final price.',
        ],
        details: [
          { label: 'Item', value: input.itemTitle },
          { label: 'Reference', value: input.submissionCode },
          {
            label: 'Status',
            value: needsVerification ? 'Waiting for seller verification' : 'Waiting for DASH review',
          },
        ],
        ...(needsVerification
          ? {
              cta: {
                label: 'Verify your seller profile',
                href: sellerVerifyUrl(input.publicWebUrl),
              },
            }
          : {}),
      }),
      reference: `declutter_submission_received_${input.submissionId}`,
    });
  }

  for (const adminEmail of DECLUTTER_ADMIN_EMAILS) {
    messages.push({
      to: adminEmail,
      subject: `New Declutters item — ${input.itemTitle}`,
      text: `A new DASH Declutters item is waiting.\n\nItem: ${input.itemTitle}\nReference: ${input.submissionCode}\nSeller: ${input.sellerName}\nSeller KYC: ${input.kycStatus}\n\nOpen DASH Ops: ${reviewUrl(input.publicWebUrl)}`,
      html: dashEmailHtml({
        previewText: `New Declutters item: ${input.itemTitle}`,
        eyebrow: 'Declutters review',
        title: 'New item waiting',
        paragraphs: ['A seller submitted an item for DASH review.'],
        details: [
          { label: 'Item', value: input.itemTitle },
          { label: 'Reference', value: input.submissionCode },
          { label: 'Seller', value: input.sellerName },
          { label: 'Seller KYC', value: input.kycStatus },
        ],
        cta: { label: 'Open DASH Ops', href: reviewUrl(input.publicWebUrl) },
      }),
      reference: `declutter_admin_submission_${input.submissionId}`,
    });
  }

  return settle(email, messages);
}

export async function notifySellerDecision(
  email: EmailPort,
  input: {
    sellerEmail: string | null;
    sellerName: string;
    sellerId: string;
    decision: 'verified' | 'rejected' | 'suspended';
    reason?: string | null;
    publicWebUrl: string;
  },
): Promise<SendResult> {
  if (!input.sellerEmail) return { attempted: 0, failed: 0 };

  if (input.decision === 'verified') {
    return settle(email, [
      {
        to: input.sellerEmail,
        subject: 'You’re verified to sell on DASH Declutters',
        text: `Hello ${input.sellerName},\n\nYour seller verification has been approved. You are now verified to sell on DASH Declutters.\n\nYou will not need to upload your ID again for every item.\n\nSell an item: ${baseUrl(input.publicWebUrl)}/declutter/sell\n\nDASH Declutters`,
        html: dashEmailHtml({
          previewText: 'Your DASH Declutters seller verification has been approved.',
          eyebrow: 'DASH Declutters',
          greeting: `Hello ${input.sellerName},`,
          title: 'You’re verified to sell',
          paragraphs: [
            'Your seller verification has been approved.',
            'You will not need to upload your ID again for every item you submit.',
          ],
          cta: { label: 'Sell an item', href: `${baseUrl(input.publicWebUrl)}/declutter/sell` },
        }),
        reference: `declutter_kyc_verified_${input.sellerId}`,
      },
    ]);
  }

  if (input.decision === 'rejected') {
    const reason = input.reason?.trim() || 'We need you to review and resubmit your seller verification details.';
    return settle(email, [
      {
        to: input.sellerEmail,
        subject: 'We need an update to your DASH Declutters verification',
        text: `Hello ${input.sellerName},\n\nWe need an update before we can approve your seller verification.\n\nReason: ${reason}\n\nUpdate your verification: ${sellerVerifyUrl(input.publicWebUrl)}\n\nDASH Declutters`,
        html: dashEmailHtml({
          previewText: 'Your DASH Declutters verification needs an update.',
          eyebrow: 'DASH Declutters',
          greeting: `Hello ${input.sellerName},`,
          title: 'We need an update',
          paragraphs: [
            'We need an update before we can approve your seller verification.',
            reason,
          ],
          cta: { label: 'Update verification', href: sellerVerifyUrl(input.publicWebUrl) },
        }),
        reference: `declutter_kyc_rejected_${input.sellerId}`,
      },
    ]);
  }

  return settle(email, [
    {
      to: input.sellerEmail,
      subject: 'Selling is paused on your DASH Declutters account',
      text: `Hello ${input.sellerName},\n\nSelling has been paused on your DASH Declutters account.\n\n${input.reason ? `Reason: ${input.reason}\n\n` : ''}Contact DASH support if you need help.\n\nDASH Declutters`,
      html: dashEmailHtml({
        previewText: 'Selling is paused on your DASH Declutters account.',
        eyebrow: 'DASH Declutters',
        greeting: `Hello ${input.sellerName},`,
        title: 'Selling is paused',
        paragraphs: [
          'Selling has been paused on your DASH Declutters account.',
          ...(input.reason ? [input.reason] : []),
          'Contact DASH support if you need help.',
        ],
      }),
      reference: `declutter_kyc_suspended_${input.sellerId}`,
    },
  ]);
}

export async function notifyListingPublished(
  email: EmailPort,
  input: {
    sellerEmail: string | null;
    sellerName: string;
    itemTitle: string;
    listingId: string;
    slug: string;
    publicWebUrl: string;
  },
): Promise<SendResult> {
  if (!input.sellerEmail) return { attempted: 0, failed: 0 };
  const href = `${baseUrl(input.publicWebUrl)}/declutter/${input.slug}`;

  return settle(email, [
    {
      to: input.sellerEmail,
      subject: `Your ${input.itemTitle} listing is now live`,
      text: `Hello ${input.sellerName},\n\nYour ${input.itemTitle} listing is now live on DASH Declutters.\n\nView it here: ${href}\n\nDASH will continue handling buyer enquiries through the marketplace.\n\nDASH Declutters`,
      html: dashEmailHtml({
        previewText: `${input.itemTitle} is now live on DASH Declutters.`,
        eyebrow: 'DASH Declutters',
        greeting: `Hello ${input.sellerName},`,
        title: 'Your listing is live',
        paragraphs: [
          `${input.itemTitle} is now live on DASH Declutters.`,
          'DASH will continue handling buyer enquiries through the marketplace.',
        ],
        details: [{ label: 'Item', value: input.itemTitle }],
        cta: { label: 'View live listing', href },
      }),
      reference: `declutter_listing_live_${input.listingId}`,
    },
  ]);
}


/**
 * Alert both Declutters admin inboxes when a buyer or seller sends a message.
 * Uses the existing durable email idempotency wrapper; message content is
 * included only in the private notification, never in public listing data.
 */
export async function notifyDeclutterAdminMessage(
  prisma: PrismaClient,
  email: EmailPort,
  input: {
    messageId: string;
    senderName?: string | null;
    listingTitle?: string | null;
    listingCode?: string | null;
    message: string;
    publicWebUrl: string;
    contactRequest?: boolean;
  },
): Promise<SendResult> {
  const inboxUrl = `${baseUrl(input.publicWebUrl)}/ops/declutter/inbox`;
  const itemTitle = input.listingTitle?.trim() || 'Account support';
  const subject = input.contactRequest
    ? `New buyer enquiry — ${itemTitle}`
    : `New Declutters message — ${itemTitle}`;
  const messageText = input.message.trim().slice(0, 4000);
  const details = [
    { label: 'From', value: input.senderName?.trim() || 'Marketplace customer' },
    ...(input.listingTitle ? [{ label: 'Item', value: input.listingTitle }] : []),
    ...(input.listingCode ? [{ label: 'Reference', value: input.listingCode }] : []),
    { label: 'Message', value: messageText || 'The customer requested contact.' },
  ];
  const emailPort = notificationEmail(
    prisma,
    email,
    `declutter_admin_message:${input.messageId}`,
  );
  const messages: Parameters<EmailPort['send']>[0][] = DECLUTTER_ADMIN_EMAILS.map((to) => ({
    to,
    subject,
    text: `A new message needs your attention in DASH Declutters.\n\nFrom: ${input.senderName?.trim() || 'Marketplace customer'}\nItem: ${itemTitle}\n${input.listingCode ? `Reference: ${input.listingCode}\n` : ''}Message: ${messageText || 'The customer requested contact.'}\n\nOpen the staff inbox: ${inboxUrl}`,
    html: dashEmailHtml({
      previewText: subject,
      eyebrow: 'DASH Declutters · New message',
      title: input.contactRequest ? 'New buyer enquiry' : 'New customer message',
      paragraphs: [
        input.contactRequest
          ? 'A buyer requested an introduction to the seller. Review the message in the authenticated DASH Ops inbox.'
          : 'A customer sent a new message. Review it in the authenticated DASH Ops inbox.',
      ],
      details,
      cta: { label: 'Open Declutters inbox', href: inboxUrl },
    }),
    reference: `declutter_admin_message_${input.messageId}`,
  }));
  return settle(emailPort, messages);
}
