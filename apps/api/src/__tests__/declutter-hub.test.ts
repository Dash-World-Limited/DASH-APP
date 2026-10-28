import { afterAll, beforeAll, expect, it } from 'vitest';
import { seedDeclutterTaxonomy } from '@dash/db';
import type { EmailPort } from '@dash/domain/ports';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, type Actor, type World } from './world.js';
import { deliverHubNotifications } from '../declutter/hub.js';
import { DECLUTTER_ADMIN_EMAILS } from '../declutter/notifications.js';
import { useIntegrationTimeouts } from './timeouts.js';
useIntegrationTimeouts();
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let context: TestContext;
let world: World;
let seller: Actor;
let stranger: Actor;
let admin: Actor;
let staff: Actor;
let sellerId: string;
const sent: Parameters<EmailPort['send']>[0][] = [];
let failDelivery = false;
const email: EmailPort = {
  providerName: 'capture',
  isLive: false,
  async send(m) {
    if (failDelivery) throw new Error('Unavailable');
    sent.push(m);
    return { accepted: true, providerMessageId: `hub-${sent.length}` };
  },
};
beforeAll(async () => {
  context = await createTestContext({}, { email });
  world = await buildWorld(context.prisma);
  await seedDeclutterTaxonomy(context.prisma);
  await context.prisma.identityRole.create({
    data: { identityId: world.support.identityId, role: 'declutter_admin' },
  });
  seller = await actAs(context, world.customerA.email);
  stranger = await actAs(context, world.customerB.email);
  admin = await actAs(context, world.admin.email);
  staff = await actAs(context, world.support.email);
  sellerId = (
    await context.prisma.declutterSeller.create({
      data: {
        customerId: world.customerA.customerId,
        displayName: 'Ada <Seller>',
        kycStatus: 'verified',
        verifiedAt: new Date(),
        socialHandle: 'PRIVATE-HANDLE',
        addressLine: 'PRIVATE-ADDRESS',
        adminNotes: 'PRIVATE-NOTES',
      },
    })
  ).id;
  await elevate();
}, 180_000);
afterAll(async () => {
  await context?.close();
});
async function elevate(value: Date | null = new Date()) {
  await context.prisma.session.updateMany({
    where: { identityId: world.admin.identityId, revokedAt: null },
    data: { steppedUpAt: value },
  });
}
async function post(
  actor: Actor | null,
  url: string,
  payload: Record<string, unknown> = {},
  expected = 200,
) {
  const r = await context.app.inject({
    method: 'POST',
    url,
    payload,
    ...(actor ? { headers: actor.headers } : {}),
  });
  expect(r.statusCode, `${url}: ${r.body}`).toBe(expected);
  return r.json();
}
async function get(actor: Actor | null, url: string, expected = 200) {
  const r = await context.app.inject({
    method: 'GET',
    url,
    ...(actor ? { headers: actor.headers } : {}),
  });
  expect(r.statusCode, `${url}: ${r.body}`).toBe(expected);
  return r.json();
}
async function submit(consent = false) {
  const tax = await get(null, '/v1/declutter/taxonomy');
  const location =
    tax.locations.find((l: { slug: string }) => l.slug === 'lagos-lekki') ??
    tax.locations[0];
  const { submission } = await post(
    seller,
    '/v1/declutter/submissions',
    {
      title: 'Reading chair <script>bad()</script>',
      description: 'A sturdy chair with honest photographs.',
      categoryKey: 'home-furniture',
      condition: 'good',
      locationSlug: location.slug,
      expectedPriceKobo: 1_500_000,
      preAuthorizePrice: consent,
    },
    201,
  );
  await post(
    seller,
    `/v1/declutter/submissions/${submission.id}/photos`,
    { data: PNG, contentType: 'image/png', role: 'front' },
    201,
  );
  await post(seller, `/v1/declutter/submissions/${submission.id}/complete`);
  return submission.id as string;
}
async function checks(id: string) {
  await post(admin, `/v1/admin/declutter/submissions/${id}/checks`, {
    kind: 'safety',
    passed: true,
  });
  await post(admin, `/v1/admin/declutter/submissions/${id}/checks`, {
    kind: 'item',
    passed: true,
  });
}
async function authorize(id: string, price: number) {
  await post(admin, `/v1/admin/declutter/submissions/${id}/valuecheck`);
  await post(admin, `/v1/admin/declutter/submissions/${id}/pricing-decision`, {
    kind: 'approved',
    escalate: true,
  });
  const s = await context.prisma.declutterSubmission.findUniqueOrThrow({
    where: { id },
  });
  await post(
    admin,
    `/v1/admin/declutter/submissions/${id}/authorize`,
    s.finalPriceKobo === price
      ? { kind: 'approved' }
      : {
          kind: 'adjusted',
          priceKobo: price,
          reason: 'Human review of the item condition and market evidence.',
        },
  );
}
let journeyId: string;
let liveListingId: string;
it('proves submission → dashboard → recorded checks → changed-price email → chat → seller acceptance → Fully Approved → live', async () => {
  journeyId = await submit();
  const id = journeyId;
  const dashboard = await get(seller, '/v1/declutter/hub');
  expect(dashboard.items.some((i: { id: string }) => i.id === id)).toBe(true);
  const before = await context.prisma.declutterSubmission.findUniqueOrThrow({
    where: { id },
  });
  const detail = await get(seller, `/v1/declutter/account/items/${id}`);
  expect(detail.item.progress[0].state).toBe('completed');
  expect(JSON.stringify(detail)).not.toContain('PRIVATE-');
  await get(admin, `/v1/admin/declutter/submissions/${id}/workspace`);
  await get(admin, `/v1/admin/declutter/submissions/${id}/valuecheck`);
  const after = await context.prisma.declutterSubmission.findUniqueOrThrow({
    where: { id },
  });
  expect(after.status).toBe(before.status);
  expect(after.updatedAt).toEqual(before.updatedAt);
  await checks(id);
  expect(
    (
      await context.prisma.declutterSubmission.findUniqueOrThrow({
        where: { id },
      })
    ).status,
  ).toBe('valuation_pending');
  await authorize(id, 1_000_000);
  const priceMail = sent.find((m) => m.reference === `price:${id}:1`);
  expect(priceMail?.html).toContain(`/declutter/account/items/${id}`);
  expect(priceMail?.html).toContain('Review &amp; approve price');
  expect(priceMail?.html).toContain('15,000');
  expect(priceMail?.html).toContain('10,000');
  expect(priceMail?.html).toContain('&lt;script&gt;');
  expect(priceMail?.html).not.toContain('<script>bad');
  await deliverHubNotifications(context.app);
  expect(sent.filter((m) => m.reference === `price:${id}:1`)).toHaveLength(1);
  const offer = (await get(seller, `/v1/declutter/account/items/${id}`)).item;
  expect(offer.expectedPriceKobo).toBe(1_500_000);
  expect(offer.authorizedPriceKobo).toBe(1_000_000);
  expect(offer.actions[0].label).toBe('Price decision required');
  await post(
    admin,
    `/v1/admin/declutter/submissions/${id}/fully-approve`,
    {},
    422,
  );
  const { conversationId } = await post(
    seller,
    '/v1/declutter/conversations',
    { submissionId: id },
    201,
  );
  const incomingMessage = await post(
    seller,
    `/v1/declutter/conversations/${conversationId}/messages`,
    {
      body: 'Why was the price changed?',
      clientMessageId: 'seller-question-001',
    },
  );
  const adminAlerts = sent.filter(
    (m) => m.reference === `declutter_admin_message_${incomingMessage.messageId}`,
  );
  expect(adminAlerts).toHaveLength(2);
  expect(adminAlerts.map((m) => m.to).sort()).toEqual(
    [...DECLUTTER_ADMIN_EMAILS].sort(),
  );
  expect(adminAlerts.every((m) => m.html.includes('/ops/declutter/inbox'))).toBe(true);
  // An HTTP retry of the same message must not send duplicate email alerts.
  await post(seller, `/v1/declutter/conversations/${conversationId}/messages`, {
    body: 'Why was the price changed?',
    clientMessageId: 'seller-question-001',
  });
  expect(
    sent.filter((m) => m.reference === `declutter_admin_message_${incomingMessage.messageId}`),
  ).toHaveLength(2);
  const inbox = await get(admin, '/v1/admin/declutter/conversations');
  expect(
    inbox.conversations.find((c: { id: string }) => c.id === conversationId)
      .unreadCount,
  ).toBe(1);
  await post(admin, `/v1/admin/declutter/conversations/${conversationId}/read`);
  const reply = await post(
    admin,
    `/v1/admin/declutter/conversations/${conversationId}/messages`,
    {
      body: 'We reviewed the condition <script>unsafe</script>. Happy to help.',
      clientMessageId: 'admin-reply-001',
    },
  );
  await post(
    admin,
    `/v1/admin/declutter/conversations/${conversationId}/messages`,
    {
      body: 'We reviewed the condition <script>unsafe</script>. Happy to help.',
      clientMessageId: 'admin-reply-001',
    },
  );
  expect(
    sent.filter((m) => m.reference === `message:${reply.messageId}`),
  ).toHaveLength(1);
  expect(
    sent.find((m) => m.reference === `message:${reply.messageId}`)?.html,
  ).not.toContain('<script>unsafe');
  expect((await get(seller, '/v1/declutter/unread-count')).unreadCount).toBe(1);
  const messages = await get(
    seller,
    `/v1/declutter/conversations/${conversationId}`,
  );
  expect(messages.messages).toHaveLength(2);
  expect(messages.messages[1].senderType).toBe('staff');
  await post(seller, `/v1/declutter/conversations/${conversationId}/read`);
  expect((await get(seller, '/v1/declutter/unread-count')).unreadCount).toBe(0);
  await post(seller, `/v1/declutter/submissions/${id}/price-response`, {
    response: 'accept',
    priceKobo: 1_000_000,
  });
  expect(
    (await get(seller, `/v1/declutter/account/items/${id}`)).item.blockers,
  ).toEqual([]);
  await elevate(null);
  await post(
    admin,
    `/v1/admin/declutter/submissions/${id}/fully-approve`,
    {},
    403,
  );
  await elevate();
  await post(
    staff,
    `/v1/admin/declutter/submissions/${id}/fully-approve`,
    {},
    403,
  );
  await post(admin, `/v1/admin/declutter/submissions/${id}/fully-approve`);
  const published = await post(
    admin,
    `/v1/admin/declutter/submissions/${id}/publish`,
    {},
    201,
  );
  liveListingId = published.listing.id;
  const live = (await get(seller, `/v1/declutter/account/items/${id}`)).item;
  expect(live.status).toBe('Live');
  expect(live.progress.at(-1).state).toBe('completed');
  expect(live.listing.slug).toBe(published.listing.slug);
  await get(null, `/v1/declutter/listings/${published.listing.slug}`);
});
it('proves replacement photos remain proposed until an authorised update approval applies them to the existing live listing', async () => {
  const old = await context.prisma.declutterListing.findUniqueOrThrow({
    where: { id: liveListingId },
    include: { photos: true },
  });
  const { updateId } = await post(
    seller,
    `/v1/declutter/account/items/${journeyId}/updates`,
    {
      title: 'Better reading chair',
      description: 'The same chair photographed in daylight.',
      condition: 'good',
      keepPhotoIds: [],
    },
    201,
  );
  const newPNG = Buffer.concat([
    Buffer.from(PNG, 'base64'),
    Buffer.from('daylight'),
  ]).toString('base64');
  await post(
    seller,
    `/v1/declutter/updates/${updateId}/photos`,
    { data: newPNG, contentType: 'image/png', role: 'front' },
    201,
  );
  await post(seller, `/v1/declutter/updates/${updateId}/submit`);
  await post(seller, `/v1/declutter/updates/${updateId}/submit`);
  expect(
    (
      await context.prisma.declutterListing.findUniqueOrThrow({
        where: { id: liveListingId },
        include: { photos: true },
      })
    ).photos[0]!.storageKey,
  ).toBe(old.photos[0]!.storageKey);
  const workspace = await get(
    admin,
    `/v1/admin/declutter/submissions/${journeyId}/workspace`,
  );
  expect(workspace.item.updates[0].status).toBe('pending');
  expect(workspace.item.title).toBe(old.title);
  await post(
    admin,
    `/v1/admin/declutter/submissions/${journeyId}/fully-approve`,
    {},
    422,
  );
  await post(
    staff,
    `/v1/admin/declutter/updates/${updateId}/review`,
    { decision: 'approved' },
    403,
  );
  await post(admin, `/v1/admin/declutter/updates/${updateId}/review`, {
    decision: 'approved',
  });
  await post(admin, `/v1/admin/declutter/updates/${updateId}/review`, {
    decision: 'approved',
  });
  const updated = await context.prisma.declutterListing.findUniqueOrThrow({
    where: { id: liveListingId },
    include: { photos: true },
  });
  expect(updated.title).toBe('Better reading chair');
  expect(updated.priceKobo).toBe(old.priceKobo);
  expect(updated.photos[0]!.storageKey).not.toBe(old.photos[0]!.storageKey);
  expect(updated.revision).toBe(2);
  const item = (await get(seller, `/v1/declutter/account/items/${journeyId}`))
    .item;
  expect(item.updates[0].status).toBe('approved');
  expect(
    item.history.some(
      (e: { label: string }) => e.label === 'Item update approved',
    ),
  ).toBe(true);
});
it.each(['rejected', 'changes_requested'])(
  'keeps approved content when an update is %s and allows another update',
  async (decision) => {
    const item = (await get(seller, `/v1/declutter/account/items/${journeyId}`))
      .item;
    const { updateId } = await post(
      seller,
      `/v1/declutter/account/items/${journeyId}/updates`,
      {
        title: 'Proposed title',
        description: 'Proposed descriptive details.',
        condition: 'fair',
        keepPhotoIds: item.photos.map((p: { id: string }) => p.id),
      },
      201,
    );
    await post(seller, `/v1/declutter/updates/${updateId}/submit`);
    await post(admin, `/v1/admin/declutter/updates/${updateId}/review`, {
      decision,
      sellerMessage: 'Please use clearer, accurate item details.',
    });
    expect(
      (await get(seller, `/v1/declutter/account/items/${journeyId}`)).item
        .title,
    ).toBe(item.title);
  },
);
it.each([true, false])(
  'proves exact price with consent %s, including email suppression and tracker completion',
  async (consent) => {
    const id = await submit(consent);
    await checks(id);
    await authorize(id, 1_500_000);
    const item = (await get(seller, `/v1/declutter/account/items/${id}`)).item;
    expect(item.priceAcceptanceValid).toBe(consent);
    expect(
      item.progress.find((p: { key: string }) => p.key === 'seller_price')
        ?.state,
    ).toBe(consent ? undefined : 'action_required');
    expect(sent.filter((m) => m.reference === `price:${id}:1`)).toHaveLength(
      consent ? 0 : 1,
    );
    if (consent) {
      await post(admin, `/v1/admin/declutter/submissions/${id}/fully-approve`);
      await post(
        admin,
        `/v1/admin/declutter/submissions/${id}/publish`,
        {},
        201,
      );
    } else {
      await post(
        admin,
        `/v1/admin/declutter/submissions/${id}/fully-approve`,
        {},
        422,
      );
      await post(seller, `/v1/declutter/submissions/${id}/price-response`, {
        response: 'decline',
        priceKobo: 1_500_000,
      });
      const declined = (await get(seller, `/v1/declutter/account/items/${id}`))
        .item;
      expect(declined.status).toBe('Price declined');
      expect(declined.next).toContain('Chat with DASH');
      await post(
        admin,
        `/v1/admin/declutter/submissions/${id}/publish`,
        {},
        422,
      );
    }
  },
);
it('does not email an actively viewed chat, supports shared staff read state, and reopens resolved chats', async () => {
  const { conversationId } = await post(
    seller,
    '/v1/declutter/conversations',
    { submissionId: journeyId },
    201,
  );
  await post(
    admin,
    `/v1/admin/declutter/conversations/${conversationId}/status`,
    { status: 'resolved' },
  );
  await post(seller, `/v1/declutter/conversations/${conversationId}/messages`, {
    body: 'I need help again',
    clientMessageId: 'reopen-001',
  });
  expect(
    (await get(admin, `/v1/admin/declutter/conversations/${conversationId}`))
      .conversation.status,
  ).toBe('open');
  await post(seller, `/v1/declutter/conversations/${conversationId}/read`);
  const message = await post(
    staff,
    `/v1/admin/declutter/conversations/${conversationId}/messages`,
    { body: 'We can help.', clientMessageId: 'active-reply-001' },
  );
  expect(
    sent.filter((m) => m.reference === `message:${message.messageId}`),
  ).toHaveLength(0);
  expect(
    (
      await get(seller, `/v1/declutter/conversations/${conversationId}`)
    ).messages.some((m: { id: string }) => m.id === message.messageId),
  ).toBe(true);
});
it('keeps a failed email intent for retry and deduplicates successful delivery', async () => {
  failDelivery = true;
  const id = await submit();
  await checks(id);
  await authorize(id, 1_000_000);
  const n = await context.prisma.declutterHubNotification.findUniqueOrThrow({
    where: { eventKey: `price:${id}:1` },
  });
  expect(n.deliveredAt).toBeNull();
  failDelivery = false;
  await deliverHubNotifications(context.app);
  await deliverHubNotifications(context.app);
  expect(sent.filter((m) => m.reference === `price:${id}:1`)).toHaveLength(1);
});
it('cannot spoof an admin sender or reference another seller’s item', async () => {
  const { conversationId } = await post(
    seller,
    '/v1/declutter/conversations',
    { submissionId: journeyId },
    201,
  );
  await post(
    seller,
    `/v1/declutter/conversations/${conversationId}/messages`,
    {
      body: 'Spoof',
      clientMessageId: 'spoof-001',
      senderType: 'staff',
      senderIdentityId: world.admin.identityId,
    },
    400,
  );
  await post(
    stranger,
    '/v1/declutter/conversations',
    { submissionId: journeyId },
    404,
  );
});
it.each(['item', 'chat', 'updates', 'photos', 'submit', 'read', 'messages'])(
  'blocks another seller and signed-out access to %s',
  async (kind) => {
    const item = (await get(seller, `/v1/declutter/account/items/${journeyId}`))
      .item;
    const { conversationId } = await post(
      seller,
      '/v1/declutter/conversations',
      { submissionId: journeyId },
      201,
    );
    const { updateId } = await post(
      seller,
      `/v1/declutter/account/items/${journeyId}/updates`,
      {
        title: 'Secure update',
        description: 'Only the owner can propose this.',
        condition: 'good',
      },
      201,
    ).catch(async () => ({
      updateId: (
        await context.prisma.declutterSubmissionUpdate.findFirstOrThrow({
          where: { activeKey: journeyId },
        })
      ).id,
    }));
    const url =
      kind === 'item'
        ? `/v1/declutter/account/items/${journeyId}`
        : kind === 'chat'
          ? `/v1/declutter/conversations/${conversationId}`
          : kind === 'updates'
            ? `/v1/declutter/account/items/${journeyId}/updates`
            : ['photos', 'submit'].includes(kind)
              ? `/v1/declutter/updates/${updateId}/${kind}`
              : `/v1/declutter/conversations/${conversationId}/${kind}`;
    const read = ['item', 'chat'].includes(kind);
    for (const [actor, status] of [
      [stranger, 404],
      [null, 401],
    ] as const) {
      if (read) await get(actor, url, status);
      else
        await post(
          actor,
          url,
          kind === 'updates'
            ? {
                title: 'No access',
                description: 'Not your item update.',
                condition: 'good',
                keepPhotoIds: item.photos.map((p: { id: string }) => p.id),
              }
            : kind === 'messages'
              ? { body: 'Not yours', clientMessageId: 'not-yours-001' }
              : {},
          status,
        );
    }
  },
);
it.each([
  'safety',
  'item',
  'valuation',
  'verification',
  'fraud',
  'partner',
  'acceptance',
])('Fully Approved preserves the %s gate', async (gate) => {
  const id = await submit(true);
  await checks(id);
  await authorize(id, 1_500_000);
  if (gate === 'safety')
    await context.prisma.declutterSubmission.update({
      where: { id },
      data: { safetyReviewedAt: null },
    });
  if (gate === 'item')
    await context.prisma.declutterSubmission.update({
      where: { id },
      data: { itemReviewedAt: null },
    });
  if (gate === 'valuation')
    await context.prisma.declutterValuation.deleteMany({
      where: { submissionId: id },
    });
  if (gate === 'verification')
    await context.prisma.declutterSeller.update({
      where: { id: sellerId },
      data: { kycStatus: 'pending' },
    });
  if (gate === 'fraud')
    await context.prisma.declutterFraudFlag.create({
      data: {
        submissionId: id,
        kind: 'identity_mismatch',
        severity: 'high',
        detail: 'Test blocker',
      },
    });
  if (gate === 'partner')
    await context.prisma.declutterSubmission.update({
      where: { id },
      data: { partnerApprovalRequired: true },
    });
  if (gate === 'acceptance')
    await context.prisma.declutterSubmission.update({
      where: { id },
      data: { sellerAcceptedVersion: 0 },
    });
  await post(
    admin,
    `/v1/admin/declutter/submissions/${id}/fully-approve`,
    {},
    422,
  );
  await post(admin, `/v1/admin/declutter/submissions/${id}/publish`, {}, 422);
  if (gate === 'verification')
    await context.prisma.declutterSeller.update({
      where: { id: sellerId },
      data: { kycStatus: 'verified' },
    });
});
it('loads newest messages first without losing access to older conversation history', async () => {
  const { conversationId } = await post(
    seller,
    '/v1/declutter/conversations',
    {},
    201,
  );
  await context.prisma.declutterMessage.createMany({
    data: Array.from({ length: 105 }, (_, index) => ({
      id: `history-${String(index).padStart(3, '0')}`,
      conversationId,
      senderIdentityId: world.customerA.identityId,
      senderType: 'seller',
      body: `History ${index}`,
      clientMessageId: `history-${index}`,
      createdAt: new Date(1700000000000 + index * 1000),
    })),
  });
  const recent = await get(
    seller,
    `/v1/declutter/conversations/${conversationId}`,
  );
  expect(recent.messages).toHaveLength(100);
  expect(recent.messages.at(-1).body).toBe('History 104');
  expect(recent.messages[0].body).toBe('History 5');
  const older = await get(
    seller,
    `/v1/declutter/conversations/${conversationId}?before=${recent.nextCursor}`,
  );
  expect(older.messages).toHaveLength(5);
  expect(older.messages[0].body).toBe('History 0');
  expect(older.nextCursor).toBeNull();
  await get(
    stranger,
    `/v1/declutter/conversations/${conversationId}?before=${recent.nextCursor}`,
    404,
  );
});

it('does not let the legacy transition dropdown manufacture approval without the protected gates', async () => {
  const id = await submit();
  await checks(id);
  await authorize(id, 1_000_000);
  await post(
    admin,
    `/v1/admin/declutter/submissions/${id}/transition`,
    { to: 'approved' },
    403,
  );
  expect(
    (await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id } })).fullyApprovedAt,
  ).toBeNull();
});
it('Approve & Publish overrides internal checks, keeps evidence, and honours exact-price consent without emailing twice', async () => {
  await elevate();
  const id = await submit(true);
  await context.prisma.declutterSubmission.update({ where: { id }, data: { partnerApprovalRequired: true } });
  const flag = await context.prisma.declutterFraudFlag.create({ data: { submissionId: id, kind: 'identity_mismatch', severity: 'high', detail: 'Retained risk evidence' } });
  const final = await post(admin, `/v1/admin/declutter/submissions/${id}/approve-publish`, { priceKobo: 1_500_000, reason: 'Super Admin reviewed the retained evidence and approves publication.' });
  expect(final.published).toBe(true);
  const s = await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id }, include: { listing: true, valuations: true } });
  expect(s.status).toBe('published');
  expect(s.fullyApprovedBy).toBe(world.admin.identityId);
  expect(s.safetyReviewedAt).toBeNull();
  expect(s.itemReviewedAt).toBeNull();
  expect(s.valuations).toHaveLength(0);
  expect(s.partnerApprovedAt).toBeNull();
  expect(s.valueCheckStatus).toBe('seller_accepted');
  const evidence = await context.prisma.declutterFraudFlag.findUniqueOrThrow({ where: { id: flag.id } });
  expect(evidence.status).toBe('dismissed');
  expect(evidence.detail).toBe('Retained risk evidence');
  expect(evidence.resolvedBy).toBe(world.admin.identityId);
  const audit = await context.prisma.auditLog.findFirstOrThrow({ where: { action: 'declutter.submission.approve_publish', resourceId: id } });
  expect(JSON.parse(audit.after!).fraudFlagIds).toContain(flag.id);
  expect(audit.identityId).toBe(world.admin.identityId);
  const item = (await get(seller, `/v1/declutter/account/items/${id}`)).item;
  expect(item.progress.map((p: { label: string }) => p.label)).toEqual(['Submitted', 'Under Review', 'Approved', 'Live']);
  expect(item.progress.every((p: { state: string }) => p.state === 'completed')).toBe(true);
  expect(sent.filter(m => m.reference === `price:${id}:1`)).toHaveLength(0);
  await post(admin, `/v1/admin/declutter/submissions/${id}/approve-publish`, { priceKobo: 900_000 });
  expect(await context.prisma.declutterListing.count({ where: { submissionId: id } })).toBe(1);
  expect((await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id } })).authorizedPriceKobo).toBe(1_500_000);
  await get(null, `/v1/declutter/listings/${final.listing.slug}`);
});

it.each([true, false])('never bypasses changed-price consent (original consent: %s) and publishes on the real seller acceptance event', async consent => {
  const id = await submit(consent);
  const final = await post(admin, `/v1/admin/declutter/submissions/${id}/approve-publish`, { priceKobo: 1_000_000 });
  expect(final.published).toBe(false);
  expect(final.blockers).toContain('Seller price decision is required');
  expect(await context.prisma.declutterListing.count({ where: { submissionId: id } })).toBe(0);
  expect(sent.filter(m => m.reference === `price:${id}:1`)).toHaveLength(1);
  const before = await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id } });
  await get(seller, `/v1/declutter/account/items/${id}`);
  await get(admin, `/v1/admin/declutter/submissions/${id}/workspace`);
  expect((await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id } })).updatedAt).toEqual(before.updatedAt);
  await post(seller, `/v1/declutter/submissions/${id}/price-response`, { response: 'accept', priceKobo: 900_000 }, 409);
  await post(seller, `/v1/declutter/submissions/${id}/price-response`, { response: 'accept', priceKobo: 1_000_000 });
  expect(await context.prisma.declutterListing.count({ where: { submissionId: id } })).toBe(1);
  expect((await get(seller, `/v1/declutter/account/items/${id}`)).item.status).toBe('Live');
});

it('legacy same-price submissions still require explicit acceptance', async () => {
  const id = await submit(false);
  const final = await post(admin, `/v1/admin/declutter/submissions/${id}/approve-publish`, { priceKobo: 1_500_000 });
  expect(final.published).toBe(false);
  expect((await get(seller, `/v1/declutter/account/items/${id}`)).item.priceAcceptanceValid).toBe(false);
  await post(seller, `/v1/declutter/submissions/${id}/price-response`, { response: 'decline', priceKobo: 1_500_000 });
  expect(await context.prisma.declutterListing.count({ where: { submissionId: id } })).toBe(0);
});

it('cannot bypass required verification even with Super Admin approval and exact-price consent', async () => {
  const id = await submit(true);
  await context.prisma.declutterSeller.update({ where: { id: sellerId }, data: { kycStatus: 'pending' } });
  try {
    const final = await post(admin, `/v1/admin/declutter/submissions/${id}/approve-publish`, { priceKobo: 1_500_000 });
    expect(final.published).toBe(false);
    expect(final.blockers).toContain('Seller verification is required');
    expect(await context.prisma.declutterListing.count({ where: { submissionId: id } })).toBe(0);
  } finally { await context.prisma.declutterSeller.update({ where: { id: sellerId }, data: { kycStatus: 'verified' } }); }
});

it('keeps Super Admin permissions and step-up mandatory for final authority', async () => {
  const id = await submit(true);
  const url = `/v1/admin/declutter/submissions/${id}/approve-publish`;
  await post(seller, url, {}, 403);
  await post(staff, url, {}, 403);
  await post(null, url, {}, 401);
  await elevate(null);
  await post(admin, url, {}, 403);
  await elevate();
  expect((await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id } })).fullyApprovedAt).toBeNull();
});

it('publishes the current version while preserving a proposed replacement for separate review', async () => {
  const id = await submit(true);
  const item = (await get(seller, `/v1/declutter/account/items/${id}`)).item;
  const { updateId } = await post(seller, `/v1/declutter/account/items/${id}/updates`, { title: 'Replacement proposed chair', description: 'This proposed description still needs review.', condition: 'fair', keepPhotoIds: item.photos.map((p: { id: string }) => p.id) }, 201);
  await post(seller, `/v1/declutter/updates/${updateId}/submit`);
  const final = await post(admin, `/v1/admin/declutter/submissions/${id}/approve-publish`, { priceKobo: 1_500_000 });
  expect(final.published).toBe(true);
  expect((await context.prisma.declutterListing.findUniqueOrThrow({ where: { id: final.listing.id } })).title).toBe(item.title);
  expect((await context.prisma.declutterSubmissionUpdate.findUniqueOrThrow({ where: { id: updateId } })).status).toBe('pending');
});

it('soft-removes a live listing immediately, keeps chat/audit/photos, and cannot republish it', async () => {
  const id = await submit(true);
  const final = await post(admin, `/v1/admin/declutter/submissions/${id}/approve-publish`, { priceKobo: 1_500_000 });
  const { conversationId } = await post(seller, '/v1/declutter/conversations', { submissionId: id }, 201);
  await post(seller, `/v1/declutter/conversations/${conversationId}/messages`, { body: 'Please keep this history.', clientMessageId: 'removal-history-001' });
  const before = await get(seller, '/v1/declutter/hub');
  await post(seller, `/v1/declutter/account/items/${id}/remove`, { confirmed: true });
  await post(seller, `/v1/declutter/account/items/${id}/remove`, { confirmed: true });
  await get(null, `/v1/declutter/listings/${final.listing.slug}`, 404);
  const feed = await get(null, '/v1/declutter/listings');
  expect(JSON.stringify(feed)).not.toContain(final.listing.slug);
  const s = await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id }, include: { listing: { include: { photos: true } }, events: true } });
  expect(s.status).toBe('withdrawn');
  expect(s.listing?.availability).toBe('archived');
  expect(s.listing?.photos.length).toBeGreaterThan(0);
  expect(s.events.some(e => e.toStatus === 'withdrawn')).toBe(true);
  expect(await context.prisma.auditLog.count({ where: { action: 'declutter.submission.removed', resourceId: id } })).toBe(1);
  expect((await get(seller, `/v1/declutter/conversations/${conversationId}`)).messages[0].body).toBe('Please keep this history.');
  const dashboard = await get(seller, '/v1/declutter/hub');
  expect(dashboard.totals.total).toBe(before.totals.total - 1);
  expect(dashboard.items.find((i: { id: string }) => i.id === id).status).toBe('Removed');
  expect((await get(seller, `/v1/declutter/account/items/${id}`)).item.actions).toEqual([]);
  await post(admin, `/v1/admin/declutter/submissions/${id}/approve-publish`, {}, 409);
  await post(admin, `/v1/admin/declutter/submissions/${id}/publish`, {}, 422);
});

it('requires removal confirmation and enforces seller ownership server-side', async () => {
  const id = await submit();
  const url = `/v1/declutter/account/items/${id}/remove`;
  await post(seller, url, {}, 400);
  await post(stranger, url, { confirmed: true }, 404);
  await post(null, url, { confirmed: true }, 401);
  expect((await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id } })).status).not.toBe('withdrawn');
  await post(seller, url, { confirmed: true });
  expect((await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id } })).status).toBe('withdrawn');
});

it('keeps sold items Sold with their listing and history intact', async () => {
  const id = await submit(true);
  const final = await post(admin, `/v1/admin/declutter/submissions/${id}/approve-publish`, { priceKobo: 1_500_000 });
  await context.prisma.declutterListing.update({ where: { id: final.listing.id }, data: { availability: 'sold' } });
  await post(seller, `/v1/declutter/account/items/${id}/remove`, { confirmed: true }, 409);
  await post(admin, `/v1/admin/declutter/submissions/${id}/approve-publish`, {}, 409);
  expect((await get(seller, `/v1/declutter/account/items/${id}`)).item.status).toBe('Sold');
});
it('new risk evidence after final approval still blocks automatic publication until a fresh Super Admin decision', async () => {
  const id = await submit(true);
  await post(admin, `/v1/admin/declutter/submissions/${id}/approve-publish`, { priceKobo: 1_000_000 });
  await context.prisma.declutterFraudFlag.create({ data: { submissionId: id, kind: 'identity_mismatch', severity: 'high', detail: 'New evidence after approval' } });
  await post(seller, `/v1/declutter/submissions/${id}/price-response`, { response: 'accept', priceKobo: 1_000_000 });
  expect(await context.prisma.declutterListing.count({ where: { submissionId: id } })).toBe(0);
  const final = await post(admin, `/v1/admin/declutter/submissions/${id}/approve-publish`, { reason: 'Super Admin explicitly reviewed the newly recorded evidence.' });
  expect(final.published).toBe(true);
});
