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

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { actorOf, requireAuth } from '../http/context.js';
import { registerDevice, retireReplacedToken, revokeDeviceToken } from '../push/registration.js';

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
});

export async function registerDeviceRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app.services;

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

      const result = await prisma.$transaction(async (tx) => {
        const registered = await registerDevice(tx, {
          // From the session. The request body has no say in this.
          identityId: actor.identityId,
          pushToken: body.pushToken,
          platform: body.platform,
          model: body.model,
          appVersion: body.appVersion,
          pushEnabled: body.notifications === undefined ? undefined : body.notifications === 'on',
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
