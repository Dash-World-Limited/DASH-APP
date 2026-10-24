import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { EmailPort } from '@dash/domain/ports';

/** Reuse the existing durable idempotency store, scoped to event and recipient.
 * A provider acceptance followed by a process crash leaves a claim for manual
 * reconciliation: automatically reclaiming it could send the same email twice.
 */
export function notificationEmail(prisma: PrismaClient, email: EmailPort, event: string): EmailPort {
  return {
    providerName: email.providerName,
    isLive: email.isLive,
    async send(message) {
      const digest = createHash('sha256').update(`${event}:${message.reference}:${message.to.toLowerCase()}`).digest('hex');
      const key = `declutter_email:${digest}`;
      const existing = await prisma.idempotencyKey.findUnique({ where: { key } });
      if (existing?.completedAt) return { accepted: true, providerMessageId: key };
      try {
        await prisma.idempotencyKey.create({ data: {
          key, endpoint: 'declutter_email', lockedAt: new Date(),
          // A listing receipt must remain deduplicated beyond ordinary HTTP retries.
          expiresAt: new Date('9999-01-01T00:00:00Z'),
        } });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const winner = await prisma.idempotencyKey.findUnique({ where: { key } });
          if (winner?.completedAt) return { accepted: true, providerMessageId: key };
          throw new Error('declutter_notification_in_flight');
        }
        throw error;
      }
      let receipt;
      try {
        receipt = await email.send(message);
        if (!receipt.accepted) throw new Error('declutter_notification_not_accepted');
      } catch (error) {
        await prisma.idempotencyKey.delete({ where: { key } });
        throw error;
      }
      // Keep the claim if persistence fails after acceptance; do not resend blindly.
      await prisma.idempotencyKey.update({ where: { key }, data: {
        completedAt: new Date(), statusCode: 200, responseBody: JSON.stringify(receipt),
      } });
      return receipt;
    },
  };
}

/** Audit IDs distinguish resubmissions and repeated decisions on the same seller. */
export async function sellerNotificationEvent(prisma: PrismaClient, sellerId: string, action: string) {
  const event = await prisma.auditLog.findFirst({
    where: { resourceType: 'DeclutterSeller', resourceId: sellerId, action },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true },
  });
  return event?.id ?? `${sellerId}:${action}`;
}
