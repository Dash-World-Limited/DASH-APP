/**
 * Vendor and rider onboarding.
 *
 * During early access every vendor and rider is somebody the founder knows,
 * and is approved by hand. The shape of that:
 *
 *   1. They sign up like anyone else and prove their email with a code.
 *   2. They apply — business details for a vendor, vehicle for a rider.
 *      The application is a record and grants nothing.
 *   3. An administrator approves (or rejects). Approval is the only thing that
 *      creates the vendor or rider role, and it is audited.
 *   4. Suspension withdraws the permissions without deleting the role row,
 *      because `loadActor` honours a vendor or rider role only while the
 *      record behind it is approved.
 *
 * Phone numbers are collected at signup and never verified in V1; every
 * response that shows one says so, in the words `@dash/domain/onboarding`
 * fixes for all surfaces.
 */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit, type PrismaClient } from '@dash/db';
import {
  applyPartnerDecision,
  describePartnerStatus,
  describePhone,
  isPartnerStatus,
  PARTNER_DECISIONS,
  PartnerTransitionError,
  partnerDecisionNeedsReason,
  PHONE_VERIFICATION_FLAG,
  RIDER_VEHICLE_TYPES,
  slugForBusinessName,
  VENDOR_APPLICATION_CATEGORIES,
  type PartnerStatus,
} from '@dash/domain/onboarding';
import { ApiError } from '../http/errors.js';
import { actorOf, requireAuth, requirePermission } from '../http/context.js';
import { enqueueViaOutbox, flushOutbox } from '../events/outbox.js';

const phoneSchema = z.string().trim().regex(/^\+[1-9]\d{7,14}$/, 'Enter a valid phone number including the country code');

const vendorApplicationSchema = z.object({
  businessName: z.string().trim().min(2, 'Enter the business name').max(80),
  category: z.enum(VENDOR_APPLICATION_CATEGORIES),
  description: z.string().trim().max(500).optional(),
  citySlug: z.string().trim().min(1).max(40),
  branch: z.object({
    address: z.string().trim().min(5, 'Enter the store address').max(200),
    latitude: z.number().gte(-90).lte(90),
    longitude: z.number().gte(-180).lte(180),
    phone: phoneSchema.optional(),
  }),
});

const riderApplicationSchema = z.object({
  vehicleType: z.enum(RIDER_VEHICLE_TYPES),
  vehiclePlate: z.string().trim().min(2).max(16).optional(),
});

const decisionSchema = z.object({
  decision: z.enum(PARTNER_DECISIONS),
  reason: z.string().trim().min(3).max(500).optional(),
});

const listQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'suspended', 'all']).default('pending'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function registerOnboardingRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, email, geo, queue } = app.services;

  /** An application needs a proved email: it is where the decision is sent. */
  async function verifiedApplicant(identityId: string) {
    const identity = await prisma.identity.findUnique({
      where: { id: identityId },
      select: { id: true, email: true, emailVerifiedAt: true, displayName: true, phone: true },
    });
    if (!identity?.email || !identity.emailVerifiedAt) {
      throw ApiError.forbidden('Verify your email address before applying.');
    }
    return identity;
  }

  // =========================================================================
  // Vendor — the applicant's side
  // =========================================================================

  app.post(
    '/v1/vendor/applications',
    { preHandler: requireAuth, config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const actor = actorOf(request);
      const body = vendorApplicationSchema.parse(request.body);
      const identity = await verifiedApplicant(actor.identityId);

      // One live application or store per person. A rejected one does not
      // block a fresh attempt; anything else does, and says what it is.
      const existing = await prisma.vendorUser.findFirst({
        where: { identityId: identity.id, revokedAt: null, vendor: { status: { in: ['pending', 'approved', 'suspended'] } } },
        select: { vendor: { select: { status: true } } },
      });
      if (existing) {
        const status = describePartnerStatus(existing.vendor.status as PartnerStatus);
        throw ApiError.conflict(`You already have a store application (${status.label.toLowerCase()}).`);
      }

      const city = await prisma.city.findUnique({ where: { slug: body.citySlug }, select: { id: true } });
      if (!city) throw ApiError.badRequest('DASH does not operate in that city yet.');

      // The zone decides which riders and prices apply. A store outside every
      // zone can still apply — the administrator sees that and decides — but
      // it is recorded rather than guessed.
      let zoneId: string | null = null;
      try {
        const zones = await geo.zonesContaining({ latitude: body.branch.latitude, longitude: body.branch.longitude }, city.id);
        zoneId = zones[0] ?? null;
      } catch (error) {
        request.log.warn({ err: error }, 'zone lookup failed during vendor application');
      }

      const base = slugForBusinessName(body.businessName);
      const vendor = await prisma.$transaction(async (tx) => {
        const created = await tx.vendor.create({
          data: {
            cityId: city.id,
            name: body.businessName,
            // Suffixed so two shops with one name never collide, and so a
            // slug cannot be claimed to impersonate another store.
            slug: `${base}-${randomBytes(3).toString('hex')}`,
            description: body.description ?? null,
            category: body.category,
            status: 'pending',
          },
          select: { id: true, name: true, category: true, status: true, createdAt: true },
        });
        await tx.branch.create({
          data: {
            vendorId: created.id,
            zoneId,
            name: body.businessName,
            address: body.branch.address,
            phone: body.branch.phone ?? null,
            latitude: body.branch.latitude,
            longitude: body.branch.longitude,
            // Closed until the approved owner opens it themselves.
            state: 'closed',
          },
        });
        await tx.vendorUser.create({
          data: { vendorId: created.id, identityId: identity.id, role: 'vendor_owner' },
        });
        return created;
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'vendor.application.submitted',
        resourceType: 'vendor',
        resourceId: vendor.id,
        after: { name: vendor.name, category: vendor.category, zoned: zoneId !== null },
        ipAddress: request.ip,
        requestId: request.id,
      });

      return reply.status(201).send({
        application: {
          vendorId: vendor.id,
          businessName: vendor.name,
          category: vendor.category,
          status: describePartnerStatus('pending'),
          submittedAt: vendor.createdAt,
          insideServiceArea: zoneId !== null,
        },
        phone: describePhone(identity.phone, await phoneVerificationRequired(prisma)),
      });
    },
  );

  app.get('/v1/vendor/application', { preHandler: requireAuth }, async (request) => {
    const actor = actorOf(request);
    const link = await prisma.vendorUser.findFirst({
      where: { identityId: actor.identityId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        vendor: {
          select: { id: true, name: true, category: true, status: true, rejectionReason: true, createdAt: true, approvedAt: true },
        },
      },
    });
    if (!link) throw ApiError.notFound('No store application.');
    const identity = await prisma.identity.findUniqueOrThrow({ where: { id: actor.identityId }, select: { phone: true } });
    const status = link.vendor.status as PartnerStatus;
    return {
      application: {
        vendorId: link.vendor.id,
        businessName: link.vendor.name,
        category: link.vendor.category,
        status: describePartnerStatus(status),
        // Told to the applicant, so it is the administrator's words for them.
        reason: status === 'rejected' || status === 'suspended' ? link.vendor.rejectionReason : null,
        submittedAt: link.vendor.createdAt,
        approvedAt: link.vendor.approvedAt,
      },
      phone: describePhone(identity.phone, await phoneVerificationRequired(prisma)),
    };
  });

  // =========================================================================
  // Rider — the applicant's side
  // =========================================================================

  app.post(
    '/v1/rider/applications',
    { preHandler: requireAuth, config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const actor = actorOf(request);
      const body = riderApplicationSchema.parse(request.body);
      const identity = await verifiedApplicant(actor.identityId);

      const existing = await prisma.rider.findUnique({ where: { identityId: identity.id }, select: { id: true, status: true } });
      if (existing && existing.status !== 'rejected') {
        const status = describePartnerStatus(existing.status as PartnerStatus);
        throw ApiError.conflict(`You already have a rider application (${status.label.toLowerCase()}).`);
      }

      // `Rider.identityId` is unique, so a person re-applying after a
      // rejection reopens their record rather than creating a second one. The
      // audit log keeps the earlier decision.
      const rider = existing
        ? await prisma.rider.update({
            where: { id: existing.id },
            data: { status: 'pending', vehicleType: body.vehicleType, vehiclePlate: body.vehiclePlate ?? null, approvedAt: null, approvedBy: null },
            select: { id: true, vehicleType: true, createdAt: true },
          })
        : await prisma.rider.create({
            data: { identityId: identity.id, status: 'pending', vehicleType: body.vehicleType, vehiclePlate: body.vehiclePlate ?? null },
            select: { id: true, vehicleType: true, createdAt: true },
          });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'rider.application.submitted',
        resourceType: 'rider',
        resourceId: rider.id,
        after: { vehicleType: rider.vehicleType, reapplication: existing !== null },
        ipAddress: request.ip,
        requestId: request.id,
      });

      return reply.status(201).send({
        application: { riderId: rider.id, vehicleType: rider.vehicleType, status: describePartnerStatus('pending') },
        phone: describePhone(identity.phone, await phoneVerificationRequired(prisma)),
      });
    },
  );

  app.get('/v1/rider/application', { preHandler: requireAuth }, async (request) => {
    const actor = actorOf(request);
    const rider = await prisma.rider.findUnique({
      where: { identityId: actor.identityId },
      select: { id: true, status: true, vehicleType: true, createdAt: true, approvedAt: true },
    });
    if (!rider) throw ApiError.notFound('No rider application.');
    return {
      application: {
        riderId: rider.id,
        vehicleType: rider.vehicleType,
        status: describePartnerStatus(rider.status as PartnerStatus),
        submittedAt: rider.createdAt,
        approvedAt: rider.approvedAt,
      },
    };
  });

  // =========================================================================
  // Administrator — vendors
  // =========================================================================

  app.get('/v1/admin/vendor-applications', { preHandler: requirePermission('admin:vendor:approve') }, async (request) => {
    const query = listQuerySchema.parse(request.query);
    const vendors = await prisma.vendor.findMany({
      where: query.status === 'all' ? {} : { status: query.status },
      orderBy: { createdAt: 'asc' },
      take: query.limit,
      select: {
        id: true,
        name: true,
        category: true,
        description: true,
        status: true,
        rejectionReason: true,
        createdAt: true,
        approvedAt: true,
        city: { select: { slug: true, name: true } },
        branches: { select: { address: true, latitude: true, longitude: true, zoneId: true, phone: true }, take: 1 },
        vendorUsers: {
          where: { role: 'vendor_owner', revokedAt: null },
          select: { identity: { select: { id: true, displayName: true, email: true, phone: true } } },
          take: 1,
        },
      },
    });
    return {
      applications: vendors.map((vendor) => {
        const owner = vendor.vendorUsers[0]?.identity;
        const branch = vendor.branches[0];
        return {
          vendorId: vendor.id,
          businessName: vendor.name,
          category: vendor.category,
          description: vendor.description,
          city: vendor.city,
          status: describePartnerStatus(vendor.status as PartnerStatus),
          reason: vendor.rejectionReason,
          submittedAt: vendor.createdAt,
          approvedAt: vendor.approvedAt,
          branch: branch ? { ...branch, insideServiceArea: branch.zoneId !== null, zoneId: undefined } : null,
          owner: owner
            ? { identityId: owner.id, name: owner.displayName, email: owner.email, phone: describePhone(owner.phone, false) }
            : null,
        };
      }),
    };
  });

  app.post<{ Params: { id: string } }>(
    '/v1/admin/vendors/:id/decision',
    { preHandler: requirePermission('admin:vendor:approve') },
    async (request) => {
      const actor = actorOf(request);
      const body = decisionSchema.parse(request.body);
      if (partnerDecisionNeedsReason(body.decision) && !body.reason) {
        throw ApiError.badRequest('This decision needs a reason the vendor can be told.');
      }

      const vendor = await prisma.vendor.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          name: true,
          status: true,
          vendorUsers: { where: { revokedAt: null }, select: { id: true, identityId: true, role: true, branchId: true } },
        },
      });
      if (!vendor || !isPartnerStatus(vendor.status)) throw ApiError.notFound();

      const to = transition(vendor.status, body.decision);

      await prisma.$transaction(async (tx) => {
        // Conditional on the status read above, so two administrators acting
        // at once cannot both apply a decision to the same application.
        const moved = await tx.vendor.updateMany({
          where: { id: vendor.id, status: vendor.status },
          data: {
            status: to,
            ...(to === 'approved' ? { approvedAt: new Date(), approvedBy: actor.identityId, rejectionReason: null } : {}),
            ...(to === 'rejected' || to === 'suspended' ? { rejectionReason: body.reason ?? null } : {}),
          },
        });
        if (moved.count === 0) throw ApiError.conflict('This application was changed by someone else. Reload and try again.');

        if (to === 'approved') {
          // The role is created here and nowhere else. Existing rows (from a
          // reinstatement) are kept, not duplicated.
          for (const link of vendor.vendorUsers) {
            const existingRole = await tx.identityRole.findFirst({
              where: { identityId: link.identityId, role: link.role, vendorId: vendor.id },
              select: { id: true },
            });
            if (!existingRole) {
              await tx.identityRole.create({
                data: { identityId: link.identityId, role: link.role, vendorId: vendor.id, branchId: link.branchId, grantedBy: actor.identityId },
              });
            }
            await tx.vendorUser.update({ where: { id: link.id }, data: { acceptedAt: new Date() } });
          }
        }
        if (to === 'suspended') {
          // A suspended store takes no new orders. Its role rows stay, and
          // loadActor stops honouring them while the vendor is not approved.
          await tx.branch.updateMany({ where: { vendorId: vendor.id }, data: { state: 'closed' } });
        }
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: `vendor.${body.decision}`,
        resourceType: 'vendor',
        resourceId: vendor.id,
        before: { status: vendor.status },
        after: { status: to, reason: body.reason ?? null },
        ipAddress: request.ip,
        requestId: request.id,
      });

      await notifyDecision(vendor.vendorUsers.map((link) => link.identityId), 'store', vendor.name, to, body.reason);
      return { vendorId: vendor.id, status: describePartnerStatus(to) };
    },
  );

  // =========================================================================
  // Administrator — riders
  // =========================================================================

  app.get('/v1/admin/rider-applications', { preHandler: requirePermission('admin:rider:approve') }, async (request) => {
    const query = listQuerySchema.parse(request.query);
    const riders = await prisma.rider.findMany({
      where: query.status === 'all' ? {} : { status: query.status },
      orderBy: { createdAt: 'asc' },
      take: query.limit,
      select: {
        id: true,
        status: true,
        vehicleType: true,
        vehiclePlate: true,
        createdAt: true,
        approvedAt: true,
        identity: { select: { id: true, displayName: true, email: true, phone: true } },
      },
    });
    return {
      applications: riders.map((rider) => ({
        riderId: rider.id,
        vehicleType: rider.vehicleType,
        vehiclePlate: rider.vehiclePlate,
        status: describePartnerStatus(rider.status as PartnerStatus),
        submittedAt: rider.createdAt,
        approvedAt: rider.approvedAt,
        applicant: {
          identityId: rider.identity.id,
          name: rider.identity.displayName,
          email: rider.identity.email,
          phone: describePhone(rider.identity.phone, false),
        },
      })),
    };
  });

  app.post<{ Params: { id: string } }>(
    '/v1/admin/riders/:id/decision',
    { preHandler: requirePermission('admin:rider:approve') },
    async (request) => {
      const actor = actorOf(request);
      const body = decisionSchema.parse(request.body);
      if (partnerDecisionNeedsReason(body.decision) && !body.reason) {
        throw ApiError.badRequest('This decision needs a reason the rider can be told.');
      }

      const rider = await prisma.rider.findUnique({
        where: { id: request.params.id },
        select: { id: true, status: true, identityId: true },
      });
      if (!rider || !isPartnerStatus(rider.status)) throw ApiError.notFound();

      const to = transition(rider.status, body.decision);

      await prisma.$transaction(async (tx) => {
        const moved = await tx.rider.updateMany({
          where: { id: rider.id, status: rider.status },
          data: {
            status: to,
            ...(to === 'approved' ? { approvedAt: new Date(), approvedBy: actor.identityId } : {}),
            // Off the road immediately: no new offers reach a suspended rider.
            ...(to === 'suspended' ? { availability: 'offline', onlineUntil: null } : {}),
          },
        });
        if (moved.count === 0) throw ApiError.conflict('This application was changed by someone else. Reload and try again.');

        if (to === 'approved') {
          const existingRole = await tx.identityRole.findFirst({
            where: { identityId: rider.identityId, role: 'rider' },
            select: { id: true },
          });
          if (!existingRole) {
            await tx.identityRole.create({ data: { identityId: rider.identityId, role: 'rider', grantedBy: actor.identityId } });
          }
        }

        if (to === 'suspended') {
          // A suspended rider can no longer answer an offer — the rider routes
          // refuse them outright — so an order must not wait out the offer
          // clock on their behalf. Withdrawn, not declined: they did not
          // refuse the work.
          const open = await tx.dispatchOffer.findMany({
            where: { riderId: rider.id, status: 'pending' },
            select: { id: true, order: { select: { id: true, status: true } } },
          });
          for (const offer of open) {
            await tx.dispatchOffer.updateMany({
              where: { id: offer.id, status: 'pending' },
              data: { status: 'withdrawn', respondedAt: new Date() },
            });
            if (offer.order.status === 'preparing') {
              await enqueueViaOutbox(tx, {
                name: 'dispatch.find_rider',
                payload: { orderId: offer.order.id },
                idempotencyKey: `dispatch_${offer.order.id}_requeue_${offer.id}`,
              });
            }
          }
        }
      });

      if (to === 'suspended') await flushOutbox(prisma, queue);

      // Deliveries already in the rider's hands are not moved automatically:
      // the food may be on their bike. Ops reassigns them deliberately, and
      // the count here is what tells the administrator there is work to do.
      const activeDeliveries =
        to === 'suspended'
          ? await prisma.order.count({
              where: { riderId: rider.id, status: { in: ['rider_assigned', 'rider_arrived', 'picked_up', 'en_route', 'arrived'] } },
            })
          : 0;

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: `rider.${body.decision}`,
        resourceType: 'rider',
        resourceId: rider.id,
        before: { status: rider.status },
        after: { status: to, reason: body.reason ?? null },
        ipAddress: request.ip,
        requestId: request.id,
      });

      await notifyDecision([rider.identityId], 'rider account', null, to, body.reason);
      return { riderId: rider.id, status: describePartnerStatus(to), activeDeliveriesToReassign: activeDeliveries };
    },
  );

  function transition(from: PartnerStatus, decision: (typeof PARTNER_DECISIONS)[number]): PartnerStatus {
    try {
      return applyPartnerDecision(from, decision);
    } catch (error) {
      if (error instanceof PartnerTransitionError) throw ApiError.conflict(error.message);
      throw error;
    }
  }

  /**
   * Tell the person. Best effort: the decision is already committed and
   * audited, and an email outage must not undo it or report it as failed.
   */
  async function notifyDecision(
    identityIds: readonly string[],
    what: string,
    name: string | null,
    to: PartnerStatus,
    reason: string | undefined,
  ): Promise<void> {
    const recipients = await prisma.identity.findMany({
      where: { id: { in: [...identityIds] }, emailVerifiedAt: { not: null } },
      select: { email: true, displayName: true },
    });
    const subject = `Your DASH ${what}: ${describePartnerStatus(to).label.toLowerCase()}`;
    const detail =
      to === 'approved'
        ? `Your DASH ${what}${name ? ` "${name}"` : ''} has been approved. Sign in to the DASH app to get started.`
        : `Your DASH ${what}${name ? ` "${name}"` : ''} is now ${describePartnerStatus(to).label.toLowerCase()}.${reason ? `\n\nReason: ${reason}` : ''}`;
    for (const recipient of recipients) {
      if (!recipient.email) continue;
      try {
        await email.send({
          to: recipient.email,
          subject,
          text: `Hello ${recipient.displayName ?? 'there'},\n\n${detail}\n\nDASH World Limited`,
          html: `<p>Hello ${escapeHtml(recipient.displayName ?? 'there')},</p><p>${escapeHtml(detail).replace(/\n/g, '<br>')}</p><p>DASH World Limited</p>`,
          reference: `partner_decision_${to}`,
        });
      } catch (error) {
        app.log.warn({ err: error }, 'partner decision email could not be sent');
      }
    }
  }
}

/** Whether SMS verification is currently demanded. Off unless the flag says otherwise. */
export async function phoneVerificationRequired(prisma: PrismaClient): Promise<boolean> {
  const flag = await prisma.featureFlag.findUnique({ where: { key: PHONE_VERIFICATION_FLAG }, select: { isEnabled: true } });
  return flag?.isEnabled === true;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
