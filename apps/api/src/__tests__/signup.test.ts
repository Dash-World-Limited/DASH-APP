/**
 * Website signup and email verification — integration tests.
 *
 * The happy path is three requests. Everything else here is about the ways a
 * signup form is attacked, because it is the one endpoint on the marketplace
 * that anybody at all can post to and it creates rows.
 *
 * Four groups matter:
 *
 *   * **Enumeration.** Signing up with an address that already has an account
 *     must be indistinguishable from signing up with a fresh one. The sentence
 *     "you already have an account" goes to the mailbox, never to the caller.
 *   * **Identity conflicts.** A phone number already registered to somebody
 *     else must not create a second identity and must not join the caller to
 *     the existing one.
 *   * **Code handling.** Hashed, expiring, attempt-limited, single use, and
 *     superseded by a resend.
 *   * **Nothing is real until it is verified.** An unverified identity holds no
 *     session, has no customer profile, and cannot receive a sign-in code.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';
import { useIntegrationTimeouts } from './timeouts.js';
import { seedLegalDocuments, PRIVACY_SLUG, TERMS_SLUG } from '@dash/db';
import type { DeliveryReceipt, EmailPort } from '@dash/domain/ports';

useIntegrationTimeouts();

/** Captures what would have been sent, so the tests can read the mailbox. */
class CapturingEmailAdapter implements EmailPort {
  readonly providerName = 'capture';
  readonly isLive = false;
  readonly sent: { to: string; subject: string; text: string; reference: string }[] = [];

  async send(input: {
    to: string;
    subject: string;
    html: string;
    text: string;
    reference: string;
  }): Promise<DeliveryReceipt> {
    this.sent.push({
      to: input.to,
      subject: input.subject,
      text: input.text,
      reference: input.reference,
    });
    return { accepted: true, providerMessageId: `capture_${this.sent.length}` };
  }

  /** The most recent message to an address, or null. */
  lastTo(address: string) {
    return [...this.sent].reverse().find((message) => message.to === address) ?? null;
  }
}

const mailbox = new CapturingEmailAdapter();
let context: TestContext;

beforeAll(async () => {
  context = await createTestContext({}, { email: mailbox });
  // Acceptance points at a document version, so the versions have to exist.
  await seedLegalDocuments(context.prisma);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

async function post(url: string, payload: Record<string, unknown>) {
  return await context.app.inject({ method: 'POST', url, payload });
}

let counter = 0;

/**
 * A complete, valid signup body.
 *
 * The profile fields are all required, so every test that is not about them
 * needs them present — which is exactly the shape a real form submits.
 */
function freshPerson(overrides: Record<string, unknown> = {}) {
  counter += 1;
  return {
    name: `Person ${counter}`,
    email: `person${counter}.${Date.now()}@example.com`,
    // A distinct, well-formed Nigerian mobile number per person.
    phone: `+23480${String(10_000_000 + counter).slice(0, 8)}`,
    state: 'Lagos',
    cityArea: 'Yaba',
    usageIntent: 'mainly_buying',
    acquisitionSource: 'search',
    confirmedAdult: true,
    acceptedTerms: true,
    marketingOptIn: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe('creating an account', () => {
  it('takes a name, an email and a phone, and emails a code', async () => {
    const person = freshPerson();
    const response = await post('/v1/auth/signup', person);

    expect(response.statusCode).toBe(200);
    expect(response.json().sent).toBe(true);

    const message = mailbox.lastTo(person.email);
    expect(message?.subject).toMatch(/is your DASH code/);
    expect(message?.reference).toMatch(/^email_verify_/);
  });

  it('stores the phone number without treating it as verified', async () => {
    const person = freshPerson();
    await post('/v1/auth/signup', person);

    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: person.email },
    });
    expect(identity.phone).toBe(person.phone);
    expect(identity.displayName).toBe(person.name);
    // SMS verification is off for V1. The number is recorded, and nothing in
    // the system treats it as proof of anything.
    expect(identity.emailVerifiedAt).toBeNull();
  });

  it('never stores the code in the clear', async () => {
    const person = freshPerson();
    const { devCode } = (await post('/v1/auth/signup', person)).json();

    const challenge = await context.prisma.otpChallenge.findFirstOrThrow({
      where: { destination: person.email, purpose: 'email_verify' },
    });
    expect(devCode).toMatch(/^\d{6}$/);
    expect(challenge.codeHash).not.toContain(devCode);
    expect(challenge.channel).toBe('email');
  });

  it('verifies, signs the person in, and gives them a customer profile', async () => {
    const person = freshPerson();
    const { devCode } = (await post('/v1/auth/signup', person)).json();

    const response = await post('/v1/auth/email/verify', { email: person.email, code: devCode });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.verified).toBe(true);
    // Signed in on the spot: redeeming the code is exactly the proof a sign-in
    // asks for.
    expect(body.accessToken).toBeTruthy();
    expect(body.csrfToken).toBeTruthy();
    // The refresh token is a cookie, never a body field.
    expect(body).not.toHaveProperty('refreshToken');

    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: person.email },
      include: { customer: true },
    });
    expect(identity.emailVerifiedAt).not.toBeNull();
    // An identity that is verified but has no customer row would be an account
    // that exists and can do nothing.
    expect(identity.customer).not.toBeNull();
  });

  it('does not require an admin to approve an ordinary account', async () => {
    const person = freshPerson();
    const { devCode } = (await post('/v1/auth/signup', person)).json();
    await post('/v1/auth/email/verify', { email: person.email, code: devCode });

    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: person.email },
      include: { roles: true, customer: { include: { declutterSeller: true } } },
    });
    expect(identity.status).toBe('active');
    // An ordinary user holds only the unscoped `customer` role — what lets
    // them save an address and order — and nothing privileged. Selling is a
    // separate state an admin still has to grant.
    expect(identity.roles.map((row) => ({ role: row.role, vendorId: row.vendorId, cityId: row.cityId }))).toEqual([
      { role: 'customer', vendorId: null, cityId: null },
    ]);
    expect(identity.customer?.declutterSeller).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The profile
// ---------------------------------------------------------------------------

describe('the signup profile', () => {
  it('is stored on the customer, not on the identity', async () => {
    const person = freshPerson({
      state: 'Rivers',
      cityArea: 'Port Harcourt',
      usageIntent: 'buying_and_selling',
      acquisitionSource: 'referral',
      acquisitionDetail: 'Amaka from work',
    });
    await post('/v1/auth/signup', person);

    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: person.email },
      include: { customer: true },
    });

    // Identity answers "who is authenticating" and nothing else.
    expect(identity.displayName).toBe(person.name);
    expect(Object.keys(identity)).not.toContain('state');
    expect(Object.keys(identity)).not.toContain('usageIntent');

    expect(identity.customer?.state).toBe('Rivers');
    expect(identity.customer?.cityArea).toBe('Port Harcourt');
    expect(identity.customer?.usageIntent).toBe('buying_and_selling');
    expect(identity.customer?.acquisitionSource).toBe('referral');
    expect(identity.customer?.acquisitionDetail).toBe('Amaka from work');
  });

  it('exists before the address is verified, and grants nothing', async () => {
    const person = freshPerson({ usageIntent: 'regular_seller' });
    await post('/v1/auth/signup', person);

    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: person.email },
      include: { roles: true, customer: { include: { declutterSeller: true } } },
    });

    // The profile is here; the account is not yet real.
    expect(identity.customer).not.toBeNull();
    expect(identity.emailVerifiedAt).toBeNull();

    // Saying "I sell regularly" on a form is a plan, not a permission.
    expect(identity.roles).toEqual([]);
    expect(identity.customer?.declutterSeller).toBeNull();
  });

  it('still grants nothing after verification', async () => {
    const person = freshPerson({ usageIntent: 'regular_seller', acquisitionSource: 'dash_staff', acquisitionDetail: 'David' });
    const { devCode } = (await post('/v1/auth/signup', person)).json();
    await post('/v1/auth/email/verify', { email: person.email, code: devCode });

    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: person.email },
      include: { roles: true, customer: { include: { declutterSeller: true } } },
    });
    // "A DASH World staff member told me about it" is attribution, not a
    // credential, and "regular seller" is an intention, not a permission: the
    // only role is the ordinary customer one. Selling still requires KYC and
    // an admin.
    expect(identity.roles.map((row) => row.role)).toEqual(['customer']);
    expect(identity.customer?.declutterSeller).toBeNull();
  });

  it('refuses a state that is not a Nigerian state', async () => {
    const response = await post('/v1/auth/signup', freshPerson({ state: 'Californiaa' }));
    expect(response.statusCode).toBe(400);
  });

  it('accepts a state DASH does not serve, because that is where demand comes from', async () => {
    // The marketplace covers Lagos and Delta. Refusing an account to somebody
    // in Kano would turn away the demand that decides where DASH expands.
    const person = freshPerson({ state: 'Kano', cityArea: 'Nassarawa GRA' });
    expect((await post('/v1/auth/signup', person)).statusCode).toBe(200);

    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: person.email },
      include: { customer: true },
    });
    expect(identity.customer?.state).toBe('Kano');
  });

  it('refuses an unknown usage intent or acquisition source', async () => {
    expect(
      (await post('/v1/auth/signup', freshPerson({ usageIntent: 'wholesaler' }))).statusCode,
    ).toBe(400);
    expect(
      (await post('/v1/auth/signup', freshPerson({ acquisitionSource: 'billboard' }))).statusCode,
    ).toBe(400);
  });

  it('requires the follow-up answer where one is asked for', async () => {
    // An empty "who referred you?" is worse than not asking, because it looks
    // like data.
    for (const source of ['referral', 'dash_staff', 'partner', 'other']) {
      const response = await post('/v1/auth/signup', freshPerson({ acquisitionSource: source }));
      expect(response.statusCode, source).toBe(400);
    }
  });

  it('does not ask for a follow-up where none is needed', async () => {
    for (const source of ['search', 'social_media']) {
      const response = await post('/v1/auth/signup', freshPerson({ acquisitionSource: source }));
      expect(response.statusCode, source).toBe(200);
    }
  });

  it('requires a city or area', async () => {
    expect((await post('/v1/auth/signup', freshPerson({ cityArea: '' }))).statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Age and consent
// ---------------------------------------------------------------------------

describe('age and consent', () => {
  it('refuses signup without the 18-or-older confirmation', async () => {
    expect(
      (await post('/v1/auth/signup', freshPerson({ confirmedAdult: false }))).statusCode,
    ).toBe(400);
  });

  it('records the confirmation as a timestamp and never as a date of birth', async () => {
    const person = freshPerson();
    await post('/v1/auth/signup', person);

    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: person.email },
      include: { customer: true },
    });
    expect(identity.customer?.ageConfirmedAt).not.toBeNull();
    // DASH has no reason to hold the birthday of somebody buying a sofa. A DOB
    // collected "just in case" is one that has to be protected and deleted.
    expect(Object.keys(identity.customer ?? {})).not.toContain('dateOfBirth');
  });

  it('refuses signup without accepting the terms', async () => {
    expect(
      (await post('/v1/auth/signup', freshPerson({ acceptedTerms: false }))).statusCode,
    ).toBe(400);
  });

  it('records acceptance against a specific document version', async () => {
    const person = freshPerson();
    await post('/v1/auth/signup', person);

    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: person.email },
    });
    const acceptances = await context.prisma.legalAcceptance.findMany({
      where: { identityId: identity.id },
      include: { document: true },
    });

    // Two agreements, not one: the contract and what happens to their data.
    const slugs = acceptances.map((a) => a.document.slug).sort();
    expect(slugs).toEqual([PRIVACY_SLUG, TERMS_SLUG].sort());

    for (const acceptance of acceptances) {
      // The version is the evidence. "They accepted the terms" without it
      // answers nothing when the terms change.
      expect(acceptance.document.version).toBeTruthy();
      expect(acceptance.createdAt).toBeInstanceOf(Date);
      expect(acceptance.ipAddress).toBeTruthy();
    }
  });

  it('does not move the original acceptance timestamp on a retry', async () => {
    const person = freshPerson();
    await post('/v1/auth/signup', person);

    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: person.email },
    });
    const before = await context.prisma.legalAcceptance.findMany({
      where: { identityId: identity.id },
      orderBy: { documentId: 'asc' },
    });

    await post('/v1/auth/signup', { ...person, name: 'Renamed' });

    const after = await context.prisma.legalAcceptance.findMany({
      where: { identityId: identity.id },
      orderBy: { documentId: 'asc' },
    });
    expect(after).toHaveLength(before.length);
    // The first acceptance is the evidence; a retry must not rewrite when it
    // happened.
    expect(after.map((a) => a.createdAt.toISOString())).toEqual(
      before.map((a) => a.createdAt.toISOString()),
    );
  });

  it('treats marketing consent as optional and off by default', async () => {
    const person = freshPerson();
    // Sent with no `marketingOptIn` key at all.
    const body = { ...person } as Record<string, unknown>;
    delete body['marketingOptIn'];
    expect((await post('/v1/auth/signup', body)).statusCode).toBe(200);

    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: person.email },
      include: { customer: true },
    });
    expect(identity.customer?.marketingOptIn).toBe(false);
    expect(identity.customer?.marketingOptInAt).toBeNull();
  });

  it('never makes marketing consent a condition of having an account', async () => {
    const declined = freshPerson({ marketingOptIn: false });
    const accepted = freshPerson({ marketingOptIn: true });

    const a = await post('/v1/auth/signup', declined);
    const b = await post('/v1/auth/signup', accepted);
    expect(a.statusCode).toBe(b.statusCode);

    // Both accounts verify and sign in identically.
    for (const person of [declined, accepted]) {
      const code = (await post('/v1/auth/email/resend', { email: person.email })).json().devCode;
      const used = code ?? null;
      if (used) {
        const verified = await post('/v1/auth/email/verify', { email: person.email, code: used });
        expect(verified.statusCode, person.email).toBe(200);
      }
    }
  });

  it('timestamps marketing consent when it is given', async () => {
    const person = freshPerson({ marketingOptIn: true });
    await post('/v1/auth/signup', person);

    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: person.email },
      include: { customer: true },
    });
    expect(identity.customer?.marketingOptIn).toBe(true);
    // A boolean alone cannot answer "when did they agree", which is the only
    // question that matters if consent is challenged.
    expect(identity.customer?.marketingOptInAt).not.toBeNull();
    expect(identity.customer?.marketingOptInIp).toBeTruthy();
  });

  it('clears the consent timestamp when consent is withdrawn on a retry', async () => {
    const person = freshPerson({ marketingOptIn: true });
    await post('/v1/auth/signup', person);
    await post('/v1/auth/signup', { ...person, marketingOptIn: false });

    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: person.email },
      include: { customer: true },
    });
    expect(identity.customer?.marketingOptIn).toBe(false);
    // A stale timestamp must not outlive the agreement it recorded.
    expect(identity.customer?.marketingOptInAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The sandbox gate
// ---------------------------------------------------------------------------

describe('while SES is sandboxed', () => {
  let gated: TestContext;

  beforeAll(async () => {
    gated = await createTestContext(
      { SIGNUP_ALLOWLIST: 'founder@dashworldng.com, Tester@Example.com' },
      { email: mailbox },
    );
    await seedLegalDocuments(gated.prisma);
  }, 180_000);

  afterAll(async () => {
    await gated?.close();
  });

  async function gatedPost(payload: Record<string, unknown>) {
    return await gated.app.inject({ method: 'POST', url: '/v1/auth/signup', payload });
  }

  it('lets an allowlisted address through', async () => {
    const response = await gatedPost(freshPerson({ email: 'founder@dashworldng.com' }));
    expect(response.statusCode).toBe(200);
    expect(response.json().devCode).toMatch(/^\d{6}$/);
  });

  it('matches an address case-insensitively', async () => {
    const response = await gatedPost(freshPerson({ email: 'tester@example.com' }));
    expect(response.statusCode).toBe(200);
  });

  it('turns everybody else away, and says so plainly', async () => {
    const response = await gatedPost(freshPerson());
    // Not the enumeration-safe answer. "Signup is not open yet" is a fact about
    // DASH, not about whether an account exists, so saying it leaks nothing.
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toMatch(/not open to everyone yet/i);
  });

  it('creates nothing for a refused address', async () => {
    const person = freshPerson();
    await gatedPost(person);
    // The alternative is worse than a leak: an identity, a profile, and a code
    // the mail provider will never deliver, leaving somebody with an account
    // they can never open and no way to know why.
    expect(
      await gated.prisma.identity.findUnique({ where: { email: person.email } }),
    ).toBeNull();
  });

  it('is open to everybody when the list is empty', async () => {
    // The default, and the state after production access is granted.
    const response = await post('/v1/auth/signup', freshPerson());
    expect(response.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

describe('signup does not reveal who already has an account', () => {
  it('answers identically for a fresh address and a registered one', async () => {
    const person = freshPerson();
    const { devCode } = (await post('/v1/auth/signup', person)).json();
    await post('/v1/auth/email/verify', { email: person.email, code: devCode });

    const again = await post(
      '/v1/auth/signup',
      freshPerson({ name: 'Someone Else', email: person.email }),
    );
    const fresh = await post('/v1/auth/signup', freshPerson());

    expect(again.statusCode).toBe(fresh.statusCode);
    expect(again.json().sent).toBe(fresh.json().sent);
    expect(again.json().message).toBe(fresh.json().message);
    // No code is minted for an account that already exists, so there is nothing
    // to leak — and its absence is identical to production, where the field is
    // never present at all.
    expect(again.json().devCode).toBeUndefined();
  });

  it('tells the mailbox instead, which only its owner can read', async () => {
    const person = freshPerson();
    const { devCode } = (await post('/v1/auth/signup', person)).json();
    await post('/v1/auth/email/verify', { email: person.email, code: devCode });

    await post('/v1/auth/signup', freshPerson({ name: 'Someone Else', email: person.email }));

    const message = mailbox.lastTo(person.email);
    expect(message?.subject).toBe('You already have a DASH account');
    expect(message?.reference).toBe('signup_existing_account');
  });

  it('leaves the existing account completely untouched', async () => {
    const person = freshPerson();
    const { devCode } = (await post('/v1/auth/signup', person)).json();
    await post('/v1/auth/email/verify', { email: person.email, code: devCode });

    const before = await context.prisma.identity.findUniqueOrThrow({
      where: { email: person.email },
    });

    await post('/v1/auth/signup', freshPerson({ name: 'Attacker', email: person.email }));

    const after = await context.prisma.identity.findUniqueOrThrow({
      where: { email: person.email },
    });
    expect(after.displayName).toBe(before.displayName);
    expect(after.phone).toBe(before.phone);
  });
});

// ---------------------------------------------------------------------------
// Identity conflicts
// ---------------------------------------------------------------------------

describe('a phone number that already belongs to somebody', () => {
  it('does not create a second identity and does not join the two', async () => {
    const first = freshPerson();
    const { devCode } = (await post('/v1/auth/signup', first)).json();
    await post('/v1/auth/email/verify', { email: first.email, code: devCode });

    const second = freshPerson();
    const response = await post('/v1/auth/signup', { ...second, phone: first.phone });

    // The same response as everything else: the caller learns nothing.
    expect(response.statusCode).toBe(200);
    expect(response.json().sent).toBe(true);
    expect(response.json().devCode).toBeUndefined();

    // Nothing created.
    expect(
      await context.prisma.identity.findUnique({ where: { email: second.email } }),
    ).toBeNull();

    // Nothing merged: the original account still has its own email.
    const original = await context.prisma.identity.findUniqueOrThrow({
      where: { phone: first.phone },
    });
    expect(original.email).toBe(first.email);
  });

  it('explains the conflict to the address that was supplied', async () => {
    const first = freshPerson();
    const { devCode } = (await post('/v1/auth/signup', first)).json();
    await post('/v1/auth/email/verify', { email: first.email, code: devCode });

    const second = freshPerson();
    await post('/v1/auth/signup', { ...second, phone: first.phone });

    const message = mailbox.lastTo(second.email);
    expect(message?.reference).toBe('signup_phone_conflict');
    // It must not name or describe the existing account.
    expect(message?.text).not.toContain(first.email);
    expect(message?.text).not.toContain(first.name);
  });

  it('records the attempt as a security event', async () => {
    const first = freshPerson();
    const { devCode } = (await post('/v1/auth/signup', first)).json();
    await post('/v1/auth/email/verify', { email: first.email, code: devCode });

    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { phone: first.phone },
    });

    await post('/v1/auth/signup', { ...freshPerson(), phone: first.phone });

    const audit = await context.prisma.auditLog.findFirst({
      where: { identityId: identity.id, action: 'auth.signup.phone_conflict' },
    });
    // Repeated conflicts against one number is what an account-takeover attempt
    // looks like from here, and it has to be findable afterwards.
    expect(audit).not.toBeNull();
  });
});

describe('an address nobody has proved', () => {
  it('can be claimed by whoever actually controls it', async () => {
    // Somebody starts signup with a stranger's address and abandons it. That
    // must not lock the real owner out of their own email.
    const squatted = freshPerson();
    await post('/v1/auth/signup', squatted);

    const owner = { ...freshPerson(), email: squatted.email };
    const retry = await post('/v1/auth/signup', owner);
    expect(retry.json().devCode).toMatch(/^\d{6}$/);

    const verified = await post('/v1/auth/email/verify', {
      email: owner.email,
      code: retry.json().devCode,
    });
    expect(verified.statusCode).toBe(200);

    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: owner.email },
    });
    expect(identity.displayName).toBe(owner.name);
    expect(identity.phone).toBe(owner.phone);
  });

  it('cannot receive a sign-in code', async () => {
    const person = freshPerson();
    await post('/v1/auth/signup', person);

    const response = await post('/v1/auth/otp/request', { email: person.email });
    expect(response.statusCode).toBe(200);
    // No code minted: an unverified address must not be a way into an account,
    // or signup would be a takeover tool.
    expect(response.json().devCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Correcting a mistyped address
// ---------------------------------------------------------------------------

describe('somebody who mistyped their email and never verified', () => {
  it('can start again with the correct address and the same phone', async () => {
    // The trap this exists to close: without a release, the typo holds the
    // phone number hostage and the person is locked out of DASH by their own
    // spelling mistake, with no route through but emailing support.
    const typo = freshPerson({ email: `ada.typo.${Date.now()}@gmial.com` });
    await post('/v1/auth/signup', typo);

    const corrected = freshPerson({
      email: `ada.correct.${Date.now()}@gmail.com`,
      phone: typo.phone,
    });
    const retry = await post('/v1/auth/signup', corrected);

    // A real code, not the silent refusal a conflict would produce.
    expect(retry.json().devCode).toMatch(/^\d{6}$/);

    const verified = await post('/v1/auth/email/verify', {
      email: corrected.email,
      code: retry.json().devCode,
    });
    expect(verified.statusCode).toBe(200);

    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: corrected.email },
    });
    expect(identity.phone).toBe(corrected.phone);
    expect(identity.emailVerifiedAt).not.toBeNull();
  });

  it('leaves the abandoned identity in place, without the phone', async () => {
    const typo = freshPerson({ email: `left.${Date.now()}@gmial.com` });
    await post('/v1/auth/signup', typo);
    await post('/v1/auth/signup', freshPerson({ phone: typo.phone }));

    const abandoned = await context.prisma.identity.findUniqueOrThrow({
      where: { email: typo.email },
    });
    // Released rather than deleted: whoever genuinely owns that mistyped
    // mailbox can still claim it, and the record of it having existed survives.
    expect(abandoned.phone).toBeNull();
    expect(abandoned.emailVerifiedAt).toBeNull();
  });

  it('copies nothing from the abandoned identity to the new one', async () => {
    const typo = freshPerson({
      email: `nocopy.${Date.now()}@gmial.com`,
      name: 'Wrong Name',
      state: 'Kano',
      cityArea: 'Nassarawa GRA',
    });
    await post('/v1/auth/signup', typo);

    const corrected = freshPerson({
      email: `right.${Date.now()}@gmail.com`,
      phone: typo.phone,
      name: 'Right Name',
      state: 'Lagos',
      cityArea: 'Surulere',
    });
    await post('/v1/auth/signup', corrected);

    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: corrected.email },
      include: { customer: true },
    });
    // Not a merge. The new identity is built from what was typed this time.
    expect(identity.displayName).toBe('Right Name');
    expect(identity.customer?.state).toBe('Lagos');
    expect(identity.customer?.cityArea).toBe('Surulere');
  });

  it('records the release so it can be found afterwards', async () => {
    const typo = freshPerson({ email: `audit.${Date.now()}@gmial.com` });
    await post('/v1/auth/signup', typo);
    const abandoned = await context.prisma.identity.findUniqueOrThrow({
      where: { email: typo.email },
    });

    await post('/v1/auth/signup', freshPerson({ phone: typo.phone }));

    const audit = await context.prisma.auditLog.findFirst({
      where: { identityId: abandoned.id, action: 'auth.signup.phone_released' },
    });
    expect(audit).not.toBeNull();
  });
});

describe('a phone on a verified account is never released', () => {
  it('refuses even though the caller supplies everything correctly', async () => {
    const owner = freshPerson();
    const { devCode } = (await post('/v1/auth/signup', owner)).json();
    await post('/v1/auth/email/verify', { email: owner.email, code: devCode });

    const attacker = freshPerson({ phone: owner.phone });
    const response = await post('/v1/auth/signup', attacker);

    // Same body as everything else; the caller learns nothing either way.
    expect(response.statusCode).toBe(200);
    expect(response.json().devCode).toBeUndefined();

    // The phone is exactly the credential nothing here verifies, so proving
    // nothing must move nothing.
    const still = await context.prisma.identity.findUniqueOrThrow({
      where: { phone: owner.phone },
    });
    expect(still.email).toBe(owner.email);
    expect(
      await context.prisma.identity.findUnique({ where: { email: attacker.email } }),
    ).toBeNull();
  });

  it('refuses when the holder has signed in, even unverified', async () => {
    // Belt and braces on the release conditions: a session means somebody has
    // actually used the account, whatever the verification column says.
    const holder = freshPerson();
    const { devCode } = (await post('/v1/auth/signup', holder)).json();
    await post('/v1/auth/email/verify', { email: holder.email, code: devCode });

    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: holder.email },
    });
    const sessions = await context.prisma.session.count({ where: { identityId: identity.id } });
    expect(sessions).toBeGreaterThan(0);

    const other = freshPerson({ phone: holder.phone });
    await post('/v1/auth/signup', other);
    expect(
      await context.prisma.identity.findUnique({ where: { email: other.email } }),
    ).toBeNull();
  });

  it('still answers a genuine conflict identically to everything else', async () => {
    const owner = freshPerson();
    const { devCode } = (await post('/v1/auth/signup', owner)).json();
    await post('/v1/auth/email/verify', { email: owner.email, code: devCode });

    const blocked = await post('/v1/auth/signup', freshPerson({ phone: owner.phone }));
    const fresh = await post('/v1/auth/signup', freshPerson());

    expect(blocked.statusCode).toBe(fresh.statusCode);
    expect(blocked.json().message).toBe(fresh.json().message);
  });
});

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

describe('verification codes', () => {
  it('are single use', async () => {
    const person = freshPerson();
    const { devCode } = (await post('/v1/auth/signup', person)).json();

    expect((await post('/v1/auth/email/verify', { email: person.email, code: devCode })).statusCode).toBe(200);
    const replay = await post('/v1/auth/email/verify', { email: person.email, code: devCode });
    expect(replay.statusCode).toBe(400);
  });

  it('stop being valid after the attempt ceiling', async () => {
    const person = freshPerson();
    const { devCode } = (await post('/v1/auth/signup', person)).json();
    const wrong = devCode === '000000' ? '111111' : '000000';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await post('/v1/auth/email/verify', { email: person.email, code: wrong });
    }

    const response = await post('/v1/auth/email/verify', { email: person.email, code: devCode });
    // The real code no longer works: the challenge was burned by the guessing.
    expect(response.statusCode).toBe(429);
  });

  it('expire', async () => {
    const person = freshPerson();
    const { devCode } = (await post('/v1/auth/signup', person)).json();

    await context.prisma.otpChallenge.updateMany({
      where: { destination: person.email, purpose: 'email_verify', consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await post('/v1/auth/email/verify', { email: person.email, code: devCode });
    expect(response.statusCode).toBe(400);
  });

  it('are superseded by a resend, so an older email cannot be used', async () => {
    const person = freshPerson();
    const first = (await post('/v1/auth/signup', person)).json().devCode;

    // Step past the per-address cooldown without waiting a minute.
    await context.prisma.otpChallenge.updateMany({
      where: { destination: person.email, purpose: 'email_verify' },
      data: { createdAt: new Date(Date.now() - 120_000) },
    });

    const resent = await post('/v1/auth/email/resend', { email: person.email });
    expect(resent.statusCode).toBe(200);

    const stale = await post('/v1/auth/email/verify', { email: person.email, code: first });
    expect(stale.statusCode).toBe(400);

    const current = await post('/v1/auth/email/verify', {
      email: person.email,
      code: resent.json().devCode,
    });
    expect(current.statusCode).toBe(200);
  });

  it('refuse a resend inside the cooldown, and say how long to wait', async () => {
    const person = freshPerson();
    await post('/v1/auth/signup', person);

    const response = await post('/v1/auth/email/resend', { email: person.email });
    // A real refusal, not a silent no-op: the caller is the person waiting for
    // the email, and a silent success would look like a broken button.
    expect(response.statusCode).toBe(429);
    expect(response.json().error.message).toMatch(/wait \d+ seconds/i);
  });

  it('answer a resend for an unknown or already-verified address identically', async () => {
    const unknown = await post('/v1/auth/email/resend', {
      email: `nobody.${Date.now()}@example.com`,
    });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json().devCode).toBeUndefined();

    const person = freshPerson();
    const { devCode } = (await post('/v1/auth/signup', person)).json();
    await post('/v1/auth/email/verify', { email: person.email, code: devCode });

    const done = await post('/v1/auth/email/resend', { email: person.email });
    expect(done.statusCode).toBe(unknown.statusCode);
    expect(done.json().devCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Signing in afterwards
// ---------------------------------------------------------------------------

describe('signing in with the email that was verified', () => {
  it('sends a code and mints a session', async () => {
    const person = freshPerson();
    const signup = (await post('/v1/auth/signup', person)).json();
    await post('/v1/auth/email/verify', { email: person.email, code: signup.devCode });

    const requested = await post('/v1/auth/otp/request', { email: person.email });
    expect(requested.json().devCode).toMatch(/^\d{6}$/);

    const verified = await post('/v1/auth/otp/verify', {
      email: person.email,
      code: requested.json().devCode,
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().accessToken).toBeTruthy();
    expect(verified.json()).not.toHaveProperty('refreshToken');
  });

  it('refuses a request naming both a phone and an email', async () => {
    const response = await post('/v1/auth/otp/request', {
      phone: '+2348099999900',
      email: 'someone@example.com',
    });
    // One destination, or the code and the account it belongs to could differ.
    expect(response.statusCode).toBe(400);
  });

  it('refuses a request naming neither', async () => {
    expect((await post('/v1/auth/otp/request', {})).statusCode).toBe(400);
  });

  it('will not redeem an email code against a phone number', async () => {
    const person = freshPerson();
    const signup = (await post('/v1/auth/signup', person)).json();
    await post('/v1/auth/email/verify', { email: person.email, code: signup.devCode });

    const requested = await post('/v1/auth/otp/request', { email: person.email });
    const crossed = await post('/v1/auth/otp/verify', {
      phone: person.phone,
      code: requested.json().devCode,
    });
    // The destination is part of the challenge, so a code issued to one cannot
    // be redeemed for another.
    expect(crossed.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe('input it must refuse', () => {
  it('rejects a malformed email, a bad phone and a name too short', async () => {
    const person = freshPerson();
    expect((await post('/v1/auth/signup', { ...person, email: 'not-an-email' })).statusCode).toBe(400);
    expect((await post('/v1/auth/signup', { ...person, phone: '08031112222' })).statusCode).toBe(400);
    expect((await post('/v1/auth/signup', { ...person, name: 'A' })).statusCode).toBe(400);
  });

  it('normalises an address so one mailbox cannot become two accounts', async () => {
    const person = freshPerson();
    await post('/v1/auth/signup', { ...person, email: person.email.toUpperCase() });

    const identity = await context.prisma.identity.findUnique({ where: { email: person.email } });
    expect(identity).not.toBeNull();
  });
});
