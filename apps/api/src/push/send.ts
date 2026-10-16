/**
 * Sending a push, and the checks that come first.
 *
 * Three rules sit between an event happening and a handset buzzing, and all
 * are checked here rather than at the point the event was recorded.
 *
 * **Eligibility is checked at send time, not at registration.** A rider who was
 * approved when they registered a token may be suspended by the time an offer
 * exists — approvals get revoked, riders get stood down, and the gap between
 * those two moments is exactly where a stale permission does damage. The same
 * holds for an account that has since been suspended or deleted. Asking the
 * database now costs one query and means nobody is contacted on the strength
 * of something that stopped being true.
 *
 * **The phone's own choice is honoured.** Each device row carries the
 * Notifications switch its owner set on that phone. Off means nothing but
 * essential pushes — an offer while Online, a delivery being carried that is
 * cancelled — reaches it.
 *
 * **Payloads are re-checked on the way out.** `assertNoPersonalData` has
 * already run when the message was built, and runs again here, because this is
 * the last point before the data leaves our infrastructure for Google's.
 *
 * ## Once, however many times it is asked
 *
 * Every queued push arrives at least once: the outbox relay and the queue both
 * retry, which is right for durability and wrong for a lock screen. A push
 * with a dedupe key is claimed in the durable idempotency store before it is
 * sent — the same store, and the same shape, the declutter emails use — so a
 * second delivery of the same event finds the claim and sends nothing. A send
 * the provider refused releases the claim, so the queue's retry can try again;
 * a crash between the provider accepting and the claim being completed leaves
 * the claim, and the push is never repeated — a missed retry costs less than
 * a phone buzzing twice for one event.
 */

import { assertNoPersonalData, type PushMessage } from '@dash/domain/push';
import type { PushPort } from '@dash/domain/ports';
import type { DbClient, PrismaClient } from '@dash/db';

import { CapabilityDisabledError } from '../deployment/profile.js';
import { forgetInvalidTokens } from './registration.js';

export type SkipReason =
  | 'not_approved'
  | 'no_devices'
  | 'notifications_off'
  | 'inactive_account'
  | 'duplicate'
  | 'push_disabled';

export interface SendResult {
  readonly sent: boolean;
  /** Why nothing was sent, when nothing was. Diagnostic, never shown to a user. */
  readonly skipped?: SkipReason | undefined;
  readonly deviceCount?: number | undefined;
  readonly invalidTokensCleared?: number | undefined;
}

/**
 * The provider took none of a send for a reason other than dead tokens. Thrown
 * so the queue retries the job; the claim has been released for that retry.
 */
export class PushNotDeliveredError extends Error {
  constructor(readonly reason: string) {
    super(`push not delivered: ${reason}`);
    this.name = 'PushNotDeliveredError';
  }
}

/** A claimed push stays deduplicated this long — far beyond any retry. */
const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLAIM_ENDPOINT = 'push';

function claimKey(dedupeKey: string): string {
  return `push:${dedupeKey}`;
}

async function claim(db: DbClient, dedupeKey: string, now: Date): Promise<boolean> {
  try {
    await db.idempotencyKey.create({
      data: {
        key: claimKey(dedupeKey),
        endpoint: CLAIM_ENDPOINT,
        lockedAt: now,
        expiresAt: new Date(now.getTime() + CLAIM_TTL_MS),
      },
    });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return false;
    throw error;
  }
}

async function release(db: DbClient, dedupeKey: string): Promise<void> {
  await db.idempotencyKey.deleteMany({ where: { key: claimKey(dedupeKey), completedAt: null } });
}

async function complete(db: DbClient, dedupeKey: string, result: SendResult, kind: string): Promise<void> {
  // Counts and a reason, never a token or an identity.
  await db.idempotencyKey.updateMany({
    where: { key: claimKey(dedupeKey) },
    data: {
      completedAt: new Date(),
      statusCode: result.sent ? 200 : 204,
      responseBody: JSON.stringify({ kind, sent: result.sent, skipped: result.skipped ?? null, devices: result.deviceCount ?? 0 }),
    },
  });
}

/**
 * Push a message to every installation an identity is signed into.
 *
 * Returns rather than throws when there is nobody to tell. Someone with no
 * registered handset is an ordinary state — they use the web client, or have
 * not opened the app since the feature shipped — and it must not fail the job
 * that triggered it. Realtime and polling still reach them while their app is
 * open, which is the whole reason push complements the socket instead of
 * replacing it.
 */
/**
 * Which phones a deployment may send to. `appIds` is `PUSH_APP_IDS`: when it
 * is set, only devices registered by one of those app builds are sent to — a
 * staging API never reaches a phone running the production app. Empty means
 * any build (local development).
 */
export interface PushScope {
  readonly appIds?: readonly string[] | undefined;
}

export async function deliverToIdentity(
  db: PrismaClient,
  push: PushPort,
  input: { identityId: string; message: PushMessage; dedupeKey?: string | undefined; now?: Date | undefined; scope?: PushScope | undefined },
): Promise<SendResult> {
  const now = input.now ?? new Date();
  const { message } = input;

  if (input.dedupeKey && !(await claim(db, input.dedupeKey, now))) {
    return { sent: false, skipped: 'duplicate' };
  }

  const finish = async (result: SendResult): Promise<SendResult> => {
    if (input.dedupeKey) await complete(db, input.dedupeKey, result, message.kind);
    return result;
  };

  try {
    const identity = await db.identity.findUnique({ where: { id: input.identityId }, select: { status: true } });
    if (!identity || identity.status !== 'active') return await finish({ sent: false, skipped: 'inactive_account' });

    const appIds = input.scope?.appIds ?? [];
    const thisDeployment = appIds.length > 0 ? { appId: { in: [...appIds] } } : {};
    const devices = await db.device.findMany({
      where: {
        identityId: input.identityId,
        pushToken: { not: null },
        ...thisDeployment,
        ...(message.essential ? {} : { pushEnabled: true }),
      },
      select: { pushToken: true },
    });
    const tokens = devices.map((device) => device.pushToken).filter((token): token is string => typeof token === 'string');

    if (tokens.length === 0) {
      const anyDevice = message.essential
        ? 0
        : await db.device.count({ where: { identityId: input.identityId, pushToken: { not: null }, ...thisDeployment } });
      return await finish({ sent: false, skipped: anyDevice > 0 ? 'notifications_off' : 'no_devices' });
    }

    // Last gate before it leaves our infrastructure.
    assertNoPersonalData(message.data);

    let receipt;
    try {
      receipt = await push.send({
        deviceTokens: tokens,
        title: message.title,
        body: message.body,
        data: message.data,
        delivery: { channelId: message.channel, collapseKey: message.collapseKey, ttlSeconds: message.ttlSeconds },
      });
    } catch (error) {
      // A deployment without push is a configuration, not a failure to retry.
      if (error instanceof CapabilityDisabledError) return await finish({ sent: false, skipped: 'push_disabled' });
      throw error;
    }

    // A dead token is dead permanently, so it is cleared rather than retried.
    const cleared = await forgetInvalidTokens(db, receipt.invalidTokens ?? []);

    if (!receipt.accepted && cleared < tokens.length) {
      // Nothing reached a handset, and not because every handset is gone:
      // the provider is unreachable or refused the request. Retried.
      throw new PushNotDeliveredError(receipt.failureReason ?? 'not accepted');
    }

    return await finish({ sent: receipt.accepted, deviceCount: tokens.length, invalidTokensCleared: cleared });
  } catch (error) {
    if (input.dedupeKey) await release(db, input.dedupeKey);
    throw error;
  }
}

/**
 * Push a message to every installation an approved rider is signed into.
 *
 * The rider's approval is read now, so a rider stood down since the offer was
 * created is not contacted.
 */
export async function sendToRider(
  db: PrismaClient,
  push: PushPort,
  input: { riderId: string; message: PushMessage; dedupeKey?: string | undefined; scope?: PushScope | undefined },
): Promise<SendResult> {
  const rider = await db.rider.findUnique({
    where: { id: input.riderId },
    select: { status: true, identityId: true },
  });
  if (!rider || rider.status !== 'approved') {
    return { sent: false, skipped: 'not_approved' };
  }
  return deliverToIdentity(db, push, { identityId: rider.identityId, message: input.message, dedupeKey: input.dedupeKey, scope: input.scope });
}
