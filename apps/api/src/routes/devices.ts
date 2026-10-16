/**
 * Registering the handset a person is signed into.
 *
 * One endpoint, called often and changing little: clients register on sign-in,
 * on app resume, and whenever the platform rotates a push token underneath
 * them. It has to be cheap and idempotent for that reason, and it has to be
 * strict for a different one — a push token is a capability to interrupt
 * someone's phone, and the only thing standing between an attacker and that
 * capability is who the server believes the token belongs to.
 *
 * The identity is taken from the session and nowhere else. There is no field
 * in this request that names a person, which is what makes "register this
 * token to somebody else" impossible to express rather than merely rejected.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '@dash/db';

import { actorOf, requireAuth } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { flushOutbox } from '../events/outbox.js';
import { deliverPushIntent, enqueuePush } from '../push/notify.js';
import { registerDevice, retireReplacedToken, revokeDeviceToken } from '../push/registration.js';
import { PushNotDeliveredError } from '../push/send.js';

const registerSchema = z.object({
  /**
   * The provider's token for this installation. Opaque to us — we never parse
   * it, only store and present it — so the bound is a sanity limit rather than
   * a format claim. FCM tokens run to roughly 160-180 characters today and
   * have grown before.
   */
  pushToken: z.string().min(16).max(4096),
  platform: z.enum(['android', 'ios', 'web']),
  /** Diagnostic only, and shown to nobody. Bounded so it cannot become a note. */
  model: z.string().max(120).optional(),
  appVersion: z.string().max(40).optional(),
  /**
   * The phone's Notifications switch for this account. Optional so a client
   * that predates it never resets anyone's choice by omission.
   */
  notifications: z.enum(['on', 'off']).optional(),
  /** The token this installation held before the provider rotated it. */
  replacesPushToken: z.string().min(16).max(4096).optional(),
  /**
   * The app build's id — its Android application id, such as
   * `com.dashworldng.dash.staging`. A deployment with `PUSH_APP_IDS` set
   * accepts only its own builds, so a phone running the production app can
   * never be registered with staging, or the reverse.
   */
  appId: z
    .string()
    .trim()
    .max(150)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/, 'appId must be an application id')
    .optional(),
});

export async function registerDeviceRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, config, push, queue } = app.services;

  // -------------------------------------------------------------------------
  // POST /v1/devices — bind this installation to the signed-in identity
  //
  // Answers 200 whether the token was new, refreshed, or taken from a previous
  // owner. All three are ordinary: a shared handset changing hands is a
  // supported event, not an error, and the client has nothing different to do
  // about it.
  // -------------------------------------------------------------------------
  app.post(
    '/v1/devices',
    {
      preHandler: requireAuth,
      // Generous, because a client may re-register on every resume, but not
      // unbounded: this endpoint writes, and a token is a capability.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request) => {
      const body = registerSchema.parse(request.body);
      const actor = actorOf(request);

      // This deployment notifies only its own app builds. Refused before
      // anything is stored, with a message a tester can act on — a staging
      // build pointed at production, or the reverse, is a build mistake.
      const allowed = config.PUSH_APP_IDS;
      if (allowed.length > 0 && (!body.appId || !allowed.includes(body.appId))) {
        throw ApiError.forbidden('This build of DASH cannot receive notifications from this DASH service. Install the matching app build.');
      }

      const result = await prisma.$transaction(async (tx) => {
        const registered = await registerDevice(tx, {
          // From the session. The request body has no say in this.
          identityId: actor.identityId,
          pushToken: body.pushToken,
          platform: body.platform,
          model: body.model,
          appVersion: body.appVersion,
          pushEnabled: body.notifications === undefined ? undefined : body.notifications === 'on',
          appId: body.appId,
        });
        if (body.replacesPushToken) {
          await retireReplacedToken(tx, {
            identityId: actor.identityId,
            replacedToken: body.replacesPushToken,
            currentToken: body.pushToken,
          });
        }
        // This session is signed in on this installation, so signing out of it
        // silences the installation (POST /v1/auth/logout reads this link).
        await tx.session.updateMany({ where: { id: actor.sessionId }, data: { deviceId: registered.deviceId } });
        return registered;
      });

      // `rebound` is deliberately not returned. It is an operational fact about
      // the previous holder of the token, and telling the new one that somebody
      // else was signed in here would leak that somebody else existed.
      return { registered: true, deviceId: result.deviceId };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/devices/test — send a test notification to my own phones
  //
  // The end-to-end check for a tester holding a phone: it goes through the
  // real provider, to the caller's own registered phones for this
  // deployment's app builds, and nobody else's. `delaySeconds` gives time to
  // lock the phone or close DASH, so background and closed-app delivery can be
  // seen. Without a delay the answer says what happened, including Firebase's
  // error codes; with one, it says the push is queued. The answer always names
  // the provider, so a service not yet connected to Firebase says so instead
  // of pretending a notification is on its way.
  // -------------------------------------------------------------------------
  app.post(
    '/v1/devices/test',
    { preHandler: requireAuth, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request) => {
      const body = z.object({ delaySeconds: z.number().int().min(0).max(60).default(0) }).strict().parse(request.body ?? {});
      const actor = actorOf(request);
      const scope = { appIds: config.PUSH_APP_IDS };

      const devices = await prisma.device.count({
        where: {
          identityId: actor.identityId,
          pushToken: { not: null },
          ...(scope.appIds.length > 0 ? { appId: { in: [...scope.appIds] } } : {}),
        },
      });
      if (devices === 0) {
        throw ApiError.conflict(
          'No phone is registered for notifications on this account yet. Open DASH on your phone, allow notifications, then try again.',
        );
      }

      const intent = { kind: 'test' as const, identityId: actor.identityId, requestId: randomUUID() };
      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'push.test_requested',
        resourceType: 'identity',
        resourceId: actor.identityId,
        after: { devices, delaySeconds: body.delaySeconds, provider: push.providerName },
        ipAddress: request.ip,
        requestId: request.id,
      });

      const live = push.isLive;
      if (body.delaySeconds > 0) {
        await prisma.$transaction((tx) => enqueuePush(tx, intent, { delayMs: body.delaySeconds * 1000 }));
        await flushOutbox(prisma, queue);
        return { queued: true, devices, delaySeconds: body.delaySeconds, provider: push.providerName, live };
      }

      try {
        const report = await deliverPushIntent(prisma, push, intent, scope);
        const result = report.results[0];
        return {
          queued: false,
          devices,
          provider: push.providerName,
          live,
          sent: result?.sent ?? false,
          ...(result?.skipped ? { skipped: result.skipped } : {}),
          ...(result?.invalidTokensCleared ? { invalidTokensCleared: result.invalidTokensCleared } : {}),
        };
      } catch (error) {
        // Firebase's codes, never a token: what a tester needs to tell a dead
        // phone from a wrong key.
        if (error instanceof PushNotDeliveredError) {
          return { queued: false, devices, provider: push.providerName, live, sent: false, reason: error.reason };
        }
        throw error;
      }
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /v1/devices — stop sending to this installation
  //
  // Scoped to the caller's own device: a token that belongs to another identity
  // is not theirs to silence, and answering 404 rather than 403 means a caller
  // cannot use this endpoint to discover whether a token is registered at all.
  // -------------------------------------------------------------------------
  app.delete(
    '/v1/devices',
    { preHandler: requireAuth },
    async (request) => {
      const body = z.object({ pushToken: z.string().min(16).max(4096) }).parse(request.body);
      const actor = actorOf(request);

      const device = await prisma.device.findUnique({
        where: { pushToken: body.pushToken },
        select: { identityId: true },
      });
      if (!device || device.identityId !== actor.identityId) {
        return { revoked: false };
      }

      await revokeDeviceToken(prisma, body.pushToken);
      return { revoked: true };
    },
  );
}
