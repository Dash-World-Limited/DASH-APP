import type { Prisma } from '@prisma/client';
import { writeAudit } from '@dash/db';
import { canApplySubmittedPriceConsent } from '@dash/domain/declutter';
import {
  assertTransition,
  type ValueCheckState,
} from '@dash/domain/valuecheck';

/** Shared price authority: exact first-price consent, versioning and durable emails. */
export async function authorizeSubmissionPrice(
  tx: Prisma.TransactionClient,
  submissionId: string,
  priceKobo: number,
  identityId: string,
  presented: ValueCheckState = 'seller_acceptance_pending',
) {
  await tx.declutterSubmission.update({
    where: { id: submissionId },
    data: { updatedAt: new Date() },
  });
  const submission = await tx.declutterSubmission.findUniqueOrThrow({
    where: { id: submissionId },
    include: { seller: { include: { customer: true } } },
  });
  const preAccepted = canApplySubmittedPriceConsent(
    {
      ...submission,
      sellerIdentityId: submission.seller.customer?.identityId ?? null,
    },
    priceKobo,
  );
  const version = submission.authorizationVersion + 1;
  const acceptedAt = new Date();
  const updated = await tx.declutterSubmission.update({
    where: {
      id: submissionId,
      authorizationVersion: submission.authorizationVersion,
    },
    data: {
      valueCheckStatus: preAccepted
        ? assertTransition(presented, 'seller_accepted', 'seller')
        : presented,
      fullyApprovedAt: null,
      fullyApprovedBy: null,
      authorizedPriceKobo: priceKobo,
      finalPriceKobo: priceKobo,
      // Every authorisation is a new version. Submitted-price consent
      // applies only to the first; later reviews need fresh acceptance.
      authorizationVersion: { increment: 1 },
      authorizedAt: acceptedAt,
      authorizedBy: identityId,
      sellerAcceptedAt: preAccepted ? acceptedAt : null,
      sellerAcceptanceBy: preAccepted
        ? submission.submittedPriceConsentBy
        : null,
      sellerAcceptanceNote: preAccepted
        ? 'Seller explicitly pre-authorised this exact submitted price.'
        : null,
      sellerAcceptedPriceKobo: preAccepted ? priceKobo : null,
      sellerAcceptedVersion: preAccepted ? version : null,
    },
  });
  if (preAccepted)
    await writeAudit(tx, {
      identityId: submission.submittedPriceConsentBy!,
      action: 'declutter.price.pre_authorization_applied',
      resourceType: 'DeclutterSubmission',
      resourceId: submissionId,
      after: {
        priceKobo,
        authorizationVersion: version,
        consentedAt: submission.submittedPriceConsentAt!.toISOString(),
        authorizedBy: identityId,
      },
    });
  if (!preAccepted && submission.seller.customer?.identityId) {
    const eventKey = `price:${submissionId}:${version}`;
    await tx.declutterHubNotification.upsert({
      where: { eventKey },
      create: {
        eventKey,
        kind: 'price',
        submissionId,
        recipientIdentityId: submission.seller.customer.identityId,
      },
      update: {},
    });
  }
  return updated;
}
