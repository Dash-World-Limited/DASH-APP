/**
 * Who a push token belongs to, and how that changes.
 *
 * An FCM token identifies a *physical installation*, not a person. The handset
 * decides what the token is; we only ever learn it. So the question this module
 * answers is not "which tokens does this identity have?" but "who is signed
 * into this installation right now?" — and there can only be one answer at a
 * time.
 *
 * That distinction is the whole security story. A rider signs out on a
 * borrowed phone and the owner signs in; a courier hands a device to the next
 * shift; a family shares a tablet. In every case the token stays the same while
 * the person changes. If registration merely added a row per identity, the
 * previous rider would keep receiving offers on a handset they no longer hold —
 * delivered to the device, not to them — and revoking their session would not
 * stop it, because the push path never consulted the session.
 *
 * `Device.pushToken` is therefore unique across the entire table, and
 * registering a token that already exists **rebinds** it: the row moves to the
 * new identity and the old association is gone in the same statement. There is
 * no window in which two identities both hold a claim, because the database
 * will not represent one.
 *
 * The identity always comes from the authenticated session. There is no code
 * path here that reads an identity from a request body, which is what stops
 * "register this token to someone else" from being a sentence anyone can say.
 */

import type { DbClient } from '@dash/db';

export type DevicePlatform = 'android' | 'ios' | 'web';

export interface RegisterDeviceInput {
  /** From the session. Never from the client. */
  readonly identityId: string;
  readonly pushToken: string;
  readonly platform: DevicePlatform;
  readonly model?: string | undefined;
  readonly appVersion?: string | undefined;
  /**
   * The phone's Notifications switch for this account, when the app says.
   * Left out, an existing choice is kept — never silently reset — and a new
   * device, or one changing hands, starts at the default: on.
   */
  readonly pushEnabled?: boolean | undefined;
  /** Injected so the result is testable without touching the clock. */
  readonly now?: Date | undefined;
}

export interface RegisterDeviceResult {
  readonly deviceId: string;
  /**
   * True when this token was previously registered to a *different* identity
   * and has been moved. Worth surfacing: it is a legitimate, expected event on
   * a shared handset, and also exactly what a token-hijacking attempt would
   * look like, so it is the thing an operator would want counted.
   */
  readonly rebound: boolean;
}

/**
 * Bind a push token to the authenticated identity, taking it from whoever held
 * it before.
 *
 * Idempotent: registering the same token for the same identity refreshes the
 * device's details and its `lastSeenAt` and reports `rebound: false`. Clients
 * call this on sign-in, on app resume, and whenever FCM rotates a token, so it
 * runs far more often than it changes anything.
 *
 * Runs inside the caller's transaction. The read and the write have to be
 * atomic against a concurrent registration of the same token — two handsets
 * cannot hold one token, but two requests claiming it can certainly race.
 */
export async function registerDevice(
  db: DbClient,
  input: RegisterDeviceInput,
): Promise<RegisterDeviceResult> {
  const now = input.now ?? new Date();

  const existing = await db.device.findUnique({
    where: { pushToken: input.pushToken },
    select: { id: true, identityId: true },
  });

  if (existing) {
    const rebound = existing.identityId !== input.identityId;

    // The same row moves to the new owner. Not delete-then-create: a delete
    // would cascade to `Session.deviceId` and orphan sessions that are still
    // perfectly valid, and would open a window where the token belongs to
    // nobody and a concurrent registration could claim it.
    await db.device.update({
      where: { id: existing.id },
      data: {
        identityId: input.identityId,
        platform: input.platform,
        model: input.model ?? null,
        appVersion: input.appVersion ?? null,
        lastSeenAt: now,
        // Trust does not transfer with the hardware. A device the previous
        // signed-in identity had marked trusted is not trusted for its new
        // owner, and re-earning that is the point.
        ...(rebound ? { trustedAt: null } : {}),
        // Nor does the previous owner's notification choice.
        ...(input.pushEnabled !== undefined ? { pushEnabled: input.pushEnabled } : rebound ? { pushEnabled: true } : {}),
      },
    });

    return { deviceId: existing.id, rebound };
  }

  const created = await db.device.create({
    data: {
      identityId: input.identityId,
      pushToken: input.pushToken,
      platform: input.platform,
      model: input.model ?? null,
      appVersion: input.appVersion ?? null,
      lastSeenAt: now,
      pushEnabled: input.pushEnabled ?? true,
    },
    select: { id: true },
  });

  return { deviceId: created.id, rebound: false };
}

/**
 * The provider rotated this installation's token, so its old one is retired.
 *
 * Only if the old token is the caller's own: a client cannot use "this
 * replaces that" to silence somebody else's phone. Without this, a rotation
 * leaves the old row holding a token that is dead at the provider, and it is
 * only cleared after a send fails against it.
 */
export async function retireReplacedToken(
  db: DbClient,
  input: { identityId: string; replacedToken: string; currentToken: string },
): Promise<number> {
  if (input.replacedToken === input.currentToken) return 0;
  const result = await db.device.updateMany({
    where: { pushToken: input.replacedToken, identityId: input.identityId },
    data: { pushToken: null },
  });
  return result.count;
}

/**
 * Stop sending to one installation.
 *
 * The row is kept and the token cleared, rather than deleted. `Session` points
 * at `Device`, and a session that outlives its device row would lose the record
 * of where it was used — which is the audit trail, not incidental. A row with
 * no token receives nothing, which is the entire requirement.
 *
 * Many rows may hold a null token at once; the unique index permits that, which
 * is why the column is nullable.
 */
export async function revokeDeviceToken(db: DbClient, pushToken: string): Promise<number> {
  const result = await db.device.updateMany({
    where: { pushToken },
    data: { pushToken: null },
  });
  return result.count;
}

/**
 * Stop sending to every installation this identity is signed into.
 *
 * The companion to signing out everywhere. Someone who has lost a phone
 * revokes their sessions and expects the notifications to stop too — a session
 * revocation that left pushes flowing would be a promise half kept.
 */
export async function revokeAllDeviceTokens(db: DbClient, identityId: string): Promise<number> {
  const result = await db.device.updateMany({
    where: { identityId, pushToken: { not: null } },
    data: { pushToken: null },
  });
  return result.count;
}

/**
 * Drop tokens the provider has told us are dead.
 *
 * Called after a send reports `invalidTokens`. These are not transient
 * failures — an unregistered token is unregistered for good — so they are
 * cleared rather than retried, and the next send stops paying for handsets
 * that no longer exist.
 */
export async function forgetInvalidTokens(
  db: DbClient,
  tokens: readonly string[],
): Promise<number> {
  if (tokens.length === 0) return 0;
  const result = await db.device.updateMany({
    where: { pushToken: { in: [...tokens] } },
    data: { pushToken: null },
  });
  return result.count;
}
