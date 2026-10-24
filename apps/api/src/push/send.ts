/**
 * Sending a rider a push, and the checks that come first.
 *
 * Two rules sit between an event happening and a handset buzzing, and both are
 * checked here rather than at the point the event was recorded.
 *
 * **Eligibility is checked at send time, not at registration.** A rider who was
 * approved when they registered a token may be suspended by the time an offer
 * exists — approvals get revoked, riders get stood down, and the gap between
 * those two moments is exactly where a stale permission does damage. Asking the
 * database now costs one query and means a suspended rider stops being
 * contacted immediately rather than whenever their token happens to expire.
 *
 * **Payloads are re-checked on the way out.** `assertNoPersonalData` has
 * already run when the message was built, and runs again here, because this is
 * the last point before the data leaves our infrastructure for Google's.
 */

import { assertNoPersonalData, type PushMessage } from '@dash/domain/push';
import type { PushPort } from '@dash/domain/ports';
import type { DbClient } from '@dash/db';

import { forgetInvalidTokens } from './registration.js';

export interface SendResult {
  readonly sent: boolean;
  /** Why nothing was sent, when nothing was. Diagnostic, never shown to a user. */
  readonly skipped?: 'not_approved' | 'no_devices' | undefined;
  readonly deviceCount?: number | undefined;
  readonly invalidTokensCleared?: number | undefined;
}

/**
 * Push a message to every installation an approved rider is signed into.
 *
 * Returns rather than throws when there is nobody to tell. A rider with no
 * registered handset is an ordinary state — they use the web client, or have
 * not opened the app since the feature shipped — and it must not fail the job
 * that triggered it. Realtime still reaches them if their app is open, which is
 * the whole reason push complements the socket instead of replacing it.
 */
export async function sendToRider(
  db: DbClient,
  push: PushPort,
  input: { riderId: string; message: PushMessage },
): Promise<SendResult> {
  // Eligibility, now — not when the token was registered.
  const rider = await db.rider.findUnique({
    where: { id: input.riderId },
    select: { status: true, identityId: true },
  });
  if (!rider || rider.status !== 'approved') {
    return { sent: false, skipped: 'not_approved' };
  }

  const devices = await db.device.findMany({
    where: { identityId: rider.identityId, pushToken: { not: null } },
    select: { pushToken: true },
  });

  const tokens = devices
    .map((device) => device.pushToken)
    .filter((token): token is string => typeof token === 'string');

  if (tokens.length === 0) {
    return { sent: false, skipped: 'no_devices' };
  }

  // Last gate before it leaves our infrastructure.
  assertNoPersonalData(input.message.data);

  const receipt = await push.send({
    deviceTokens: tokens,
    title: input.message.title,
    body: input.message.body,
    data: input.message.data,
  });

  // A dead token is dead permanently, so it is cleared rather than retried.
  const cleared = await forgetInvalidTokens(db, receipt.invalidTokens ?? []);

  return {
    sent: receipt.accepted,
    deviceCount: tokens.length,
    invalidTokensCleared: cleared,
  };
}
