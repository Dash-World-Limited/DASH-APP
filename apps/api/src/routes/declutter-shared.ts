/**
 * Small pieces every Declutters route needs.
 *
 * Extracted when the marketplace routes arrived and there were suddenly four
 * files that all had to answer "who is acting?". `declutterActorFor` in
 * particular maps a DASH role onto the state machines' authority vocabulary,
 * and a second copy of that drifting from the first is how a moderator
 * eventually makes a decision reserved for an admin.
 */

import type { FastifyRequest } from 'fastify';
import type { DeclutterActor } from '@dash/domain/declutter';
import type { Actor } from '@dash/domain/permissions';
import { ApiError } from '../http/errors.js';

/**
 * Map a DASH actor onto the Declutter state machines' vocabulary.
 *
 * The distinction matters for the audit trail as much as for the check. A
 * super admin holds every permission, so nothing stops them acting on a
 * seller's behalf — that is the intended escape hatch — but the event must not
 * then claim the seller did it. Seniority is read from roles, and the most
 * senior wins.
 */
export function declutterActorFor(actor: Actor): DeclutterActor {
  if (actor.roles.includes('super_admin')) return 'super_admin';
  if (actor.roles.includes('declutter_admin')) return 'admin';
  if (actor.roles.includes('declutter_moderator')) return 'staff';
  return 'seller';
}

export function customerIdOf(actor: Actor): string {
  if (!actor.customerId) {
    throw ApiError.forbidden('This account cannot sell on Declutters.');
  }
  return actor.customerId;
}

export function auditContext(request: FastifyRequest): {
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
} {
  return {
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
    requestId: request.id,
  };
}

/**
 * How long a photograph's signed URL lives.
 *
 * Longer than a KYC document's two minutes, because a buyer scrolling a feed
 * on a slow connection should not watch images expire mid-page, and an item
 * photograph is meant to be seen. Still short: the bucket stays private, links
 * are minted per request, and a URL pasted into a group chat stops working
 * within the hour rather than becoming a permanent public asset we did not
 * decide to publish.
 */
export const PHOTO_LINK_SECONDS = 3600;
