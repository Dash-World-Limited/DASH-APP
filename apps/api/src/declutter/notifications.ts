import type { EmailPort } from '@dash/domain/ports';
import { dashEmailHtml } from '../email/dash-brand.js';

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
    failed: results.filter((result) => result.status === 'rejected').length,
  };
}

function reviewUrl(publicWebUrl: string): string {
  return `${publicWebUrl.replace(/\/$/, '')}/ops/declutter`;
}

function sellerVerifyUrl(publicWebUrl: string): string {
  return `${publicWebUrl.replace(/\/$/, '')}/declutter/seller/verify`;
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
        cta: { label: 'Back to selling', href: `${input.publicWebUrl.replace(/\/$/, '')}/declutter/sell` },
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
