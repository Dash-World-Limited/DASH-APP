/**
 * The suppression list, enforced.
 *
 * A wrapper rather than a check inside each adapter, and rather than a check at
 * every call site. Recording bounces is worth nothing if something still sends
 * to them; a rule that has to be remembered at eleven call sites is a rule that
 * will be forgotten at the twelfth.
 *
 * Wrapping also means the console adapter obeys it in development, so the
 * behaviour under test is the behaviour in production.
 *
 * ## What "essential" means here
 *
 * A verification or sign-in code is essential: it is the only way into an
 * account. A newsletter is not.
 *
 * A hard bounce stops both, because the mailbox does not exist and sending to
 * it damages our ability to reach everybody else. A complaint stops only the
 * non-essential kind — somebody who marked a newsletter as spam has not asked
 * to be locked out of their own account, and treating those as the same request
 * would be us deciding they had.
 */

import type { DeliveryReceipt, EmailPort } from '@dash/domain/ports';
import type { PrismaClient } from '@prisma/client';

/**
 * References that carry a code or answer a direct action by the recipient.
 *
 * An allowlist, not a blocklist. Anything unrecognised is treated as
 * non-essential, so a new kind of marketing email cannot reach a complainant by
 * having been forgotten.
 */
const ESSENTIAL_REFERENCES = [
  'email_verify_',
  'otp_login',
  'otp_step_up',
  'signup_existing_account',
  'signup_phone_conflict',
] as const;

export function isEssential(reference: string): boolean {
  return ESSENTIAL_REFERENCES.some((prefix) => reference.startsWith(prefix));
}

/** Returned instead of throwing when a message is deliberately not sent. */
export interface SuppressedReceipt extends DeliveryReceipt {
  suppressed?: true;
}

export class SuppressionAwareEmailAdapter implements EmailPort {
  readonly providerName: string;
  readonly isLive: boolean;

  constructor(
    private readonly inner: EmailPort,
    private readonly prisma: Pick<PrismaClient, 'emailSuppression'>,
  ) {
    // Reports the provider it wraps. This is a policy layer, not a provider,
    // and claiming otherwise would make `isLive` lie about whether mail is
    // actually delivered.
    this.providerName = inner.providerName;
    this.isLive = inner.isLive;
  }

  async send(input: {
    to: string;
    subject: string;
    html: string;
    text: string;
    reference: string;
  }): Promise<SuppressedReceipt> {
    const address = input.to.trim().toLowerCase();

    const suppression = await this.prisma.emailSuppression
      .findUnique({ where: { address } })
      .catch(() => null);

    if (suppression && suppression.clearedAt === null) {
      const blocked = !suppression.transactionalAllowed || !isEssential(input.reference);
      if (blocked) {
        // Not an error. The caller asked for something we have decided not to
        // do, the decision is recorded, and turning it into a thrown exception
        // would fail a signup for a reason the person cannot act on.
        return {
          accepted: false,
          providerMessageId: `suppressed_${suppression.reason}`,
          suppressed: true,
        };
      }
    }

    return await this.inner.send(input);
  }
}
