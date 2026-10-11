import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { seedDeclutterTaxonomy, seedLegalDocuments } from '@dash/db';
import type { EmailPort } from '@dash/domain/ports';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, type Actor } from './world.js';
import { DECLUTTER_ADMIN_EMAILS } from '../declutter/notifications.js';
import { notificationEmail } from '../declutter/notification-delivery.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
type Message = Parameters<EmailPort['send']>[0];
const sent: Message[] = [];
let failingRecipient: string | null = null;
let refusedRecipient: string | null = null;
const email: EmailPort = {
  providerName: 'capture', isLive: false,
  async send(message) {
    if (message.to === failingRecipient) throw new Error('fixture delivery failure');
    if (message.to === refusedRecipient) return { accepted: false, providerMessageId: 'refused' };
    sent.push(message);
    return { accepted: true, providerMessageId: `capture-${sent.length}` };
  },
};
let context: TestContext;
let admin: Actor;
beforeAll(async () => {
  context = await createTestContext({}, { email });
  const world = await buildWorld(context.prisma);
  await seedLegalDocuments(context.prisma);
  await seedDeclutterTaxonomy(context.prisma);
  admin = await actAs(context, world.admin.email);
  await context.prisma.session.updateMany({ where: { identityId: world.admin.identityId }, data: { steppedUpAt: new Date() } });
});
afterAll(async () => { await context?.close(); });

async function post(actor: Pick<Actor, 'headers'> | null, url: string, payload?: Record<string, unknown>, status = 200) {
  const response = await context.app.inject({ method: 'POST', url, payload, ...(actor ? { headers: actor.headers } : {}) });
  expect(response.statusCode, `${url}: ${response.body}`).toBe(status);
  return response.json();
}
const kyc = {
  legalName: 'Ada Seller', identityName: 'Ada Seller', nationalId: '12345678901',
  phoneE164: '+2348012345678', addressLine: '14 Example Road, Lagos', socialHandle: '@ada_seller',
};

describe('Declutters launch journey against the real API and isolated database', () => {
  it('creates an account, signs in with a DASH code, submits photos, reviews KYC and publishes with deduplicated emails', async () => {
    expect((await context.app.inject({ method: 'GET', url: '/v1/declutter/listings' })).statusCode).toBe(200);
    const address = 'launch-journey@example.com';
    const signup = await post(null, '/v1/auth/signup', {
      name: 'Ada Seller', email: address, phone: kyc.phoneE164, state: 'Lagos', cityArea: 'Lekki',
      usageIntent: 'occasional_seller', acquisitionSource: 'search', confirmedAdult: true,
      acceptedTerms: true, marketingOptIn: false,
    });
    expect(sent.at(-1)?.subject).toBe(`${signup.devCode} is your DASH code`);
    await post(null, '/v1/auth/email/verify', { email: address, code: signup.devCode });
    const login = await post(null, '/v1/auth/otp/request', { email: address });
    expect(sent.at(-1)?.subject).toBe(`${login.devCode} is your DASH code`);
    const session = await post(null, '/v1/auth/otp/verify', { email: address, code: login.devCode });
    const seller = { headers: {
      authorization: `Bearer ${session.accessToken}`, 'x-csrf-token': session.csrfToken,
      cookie: `dash_csrf=${session.csrfToken}`,
    } };
    const profile = await post(seller, '/v1/declutter/seller', { displayName: 'Ada Seller', publicArea: 'Lekki' }, 201);
    const sellerId = profile.seller.id;
    const item = await post(seller, '/v1/declutter/submissions', {
      title: 'iPhone 13 Pro 128GB', description: 'Real item, screen unmarked, includes charger.',
      condition: 'good', categoryKey: 'phones-tablets', locationSlug: 'lagos-lekki',
      expectedPriceKobo: 4_000_000, attributes: { brand: 'Apple', model: 'iPhone 13 Pro', storageGb: 128, batteryHealth: 88 },
    }, 201);
    const id = item.submission.id;
    expect(item.submission.status).toBe('kyc_pending');
    const complete = `/v1/declutter/submissions/${id}/complete`;
    await post(seller, complete, undefined, 400);
    expect(sent.filter(m => m.reference.includes(id))).toHaveLength(0);
    await post(seller, `/v1/declutter/submissions/${id}/photos`, { contentType: 'image/png', role: 'front', data: PNG }, 201);
    failingRecipient = DECLUTTER_ADMIN_EMAILS[1];
    expect((await post(seller, complete)).notified).toBe(false);
    expect(sent.filter(m => m.reference.includes(id))).toHaveLength(2);
    failingRecipient = null;
    const completions = await Promise.all([post(seller, complete), post(seller, complete)]);
    expect(completions.some(r => r.notified)).toBe(true);
    await post(seller, complete);
    expect(sent.filter(m => m.reference.includes(id)).map(m => m.to).sort()).toEqual([address, ...DECLUTTER_ADMIN_EMAILS].sort());
    await post(admin, `/v1/admin/declutter/submissions/${id}/publish`, undefined, 422);
    const doc = await post(seller, '/v1/declutter/seller/me/documents', { kind: 'national_id', contentType: 'image/png', data: PNG }, 201);
    await post(seller, '/v1/declutter/seller/me/verification', kyc);
    const verificationComplete = '/v1/declutter/seller/me/verification/complete';
    await Promise.all([post(seller, verificationComplete), post(seller, verificationComplete)]);
    await post(seller, verificationComplete);
    expect(sent.filter(m => m.reference === `declutter_kyc_received_${sellerId}`)).toHaveLength(1);
    const privateRecord = await context.app.inject({ method: 'GET', url: `/v1/admin/declutter/sellers/${sellerId}`, headers: admin.headers });
    expect(privateRecord.json().seller.socialHandle).toBe('@ada_seller');
    await post(admin, `/v1/admin/declutter/sellers/${sellerId}/decision`, { to: 'rejected', reason: 'Please replace the <blurry> ID.' });
    await post(admin, `/v1/admin/declutter/sellers/${sellerId}/decision-notification`, { decision: 'rejected', reason: 'Unrecorded reason' });
    const rejection = sent.find(m => m.reference === `declutter_kyc_rejected_${sellerId}`);
    expect(rejection?.html).toContain('&lt;blurry&gt;');
    expect(rejection?.html).not.toContain('Unrecorded reason');
    expect(sent.filter(m => m.reference === rejection?.reference)).toHaveLength(1);
    // A new submission of KYC is a distinct notification event.
    await post(seller, '/v1/declutter/seller/me/verification', { ...kyc, socialHandle: ' @ada_updated ' });
    await post(seller, verificationComplete);
    expect(sent.filter(m => m.reference === `declutter_kyc_received_${sellerId}`)).toHaveLength(2);
    await post(admin, `/v1/admin/declutter/sellers/${sellerId}/documents/${doc.document.id}/review`, { status: 'accepted' });
    refusedRecipient = address;
    await post(admin, `/v1/admin/declutter/sellers/${sellerId}/decision`, { to: 'verified' });
    expect((await context.prisma.declutterSeller.findUniqueOrThrow({ where: { id: sellerId } })).kycStatus).toBe('verified');
    refusedRecipient = null;
    await post(admin, `/v1/admin/declutter/sellers/${sellerId}/decision-notification`, { decision: 'verified' });
    await post(admin, `/v1/admin/declutter/sellers/${sellerId}/decision-notification`, { decision: 'verified' });
    expect(sent.filter(m => m.reference === `declutter_kyc_verified_${sellerId}`)).toHaveLength(1);
    expect((await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id } })).status).toBe('details_pending');
    const releaseEvent = await context.prisma.declutterSubmissionEvent.findFirst({
      where: { submissionId: id, fromStatus: 'kyc_pending', toStatus: 'details_pending', reasonCode: 'seller_verified' },
    });
    expect(releaseEvent).not.toBeNull();
    await post(admin, `/v1/admin/declutter/submissions/${id}/transition`, { to: 'valuation_pending' });
    for (const price of [3_500_000, 3_600_000, 3_700_000]) await post(admin, `/v1/admin/declutter/submissions/${id}/comparables`, {
      source: 'Fixture marketplace', description: 'iPhone 13 Pro 128GB', soldPriceKobo: price, observedAt: new Date().toISOString(),
    }, 201);
    await post(admin, `/v1/admin/declutter/submissions/${id}/valuecheck`);
    const decision = await post(admin, `/v1/admin/declutter/submissions/${id}/pricing-decision`, { kind: 'approved' });
    if (decision.valueCheckStatus === 'super_admin_approval_pending') await post(admin, `/v1/admin/declutter/submissions/${id}/authorize`, { kind: 'approved' });
    const price = await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id } });
    await post(seller, `/v1/declutter/submissions/${id}/price-response`, { response: 'accept', priceKobo: price.authorizedPriceKobo });
    const published = await post(admin, `/v1/admin/declutter/submissions/${id}/publish`, undefined, 201);
    await post(admin, `/v1/admin/declutter/listings/${published.listing.id}/published-notification`);
    expect(sent.filter(m => m.reference === `declutter_listing_live_${published.listing.id}`)).toHaveLength(1);
    expect((await context.app.inject({ method: 'GET', url: `/v1/declutter/listings/${published.listing.slug}` })).statusCode).toBe(200);
    const publicSeller = await context.app.inject({ method: 'GET', url: `/v1/declutter/sellers/${sellerId}` });
    expect(publicSeller.body).not.toContain('socialHandle');
    expect(publicSeller.body).not.toContain('ada_updated');
  });

  it('persists recipient claims across adapter instances and does not resend an unfinished claim', async () => {
    const message = { to: 'claim@example.com', subject: 'Receipt', html: '<p>Receipt</p>', text: 'Receipt', reference: 'claim-test' };
    await notificationEmail(context.prisma, email, 'claim-event').send(message);
    await notificationEmail(context.prisma, email, 'claim-event').send(message);
    expect(sent.filter(m => m.reference === message.reference)).toHaveLength(1);
    const digest = createHash('sha256').update(`claim-event:${message.reference}:${message.to}`).digest('hex');
    const claim = await context.prisma.idempotencyKey.findUniqueOrThrow({ where: { key: `declutter_email:${digest}` } });
    await context.prisma.idempotencyKey.update({ where: { id: claim.id }, data: { completedAt: null } });
    await expect(notificationEmail(context.prisma, email, 'claim-event').send(message)).rejects.toThrow('in_flight');
  });
});
