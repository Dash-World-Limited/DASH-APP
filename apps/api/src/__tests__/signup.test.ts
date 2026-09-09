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
}, 180_000);

afterAll(async () => {
  await context?.close();
});

async function post(url: string, payload: Record<string, unknown>) {
  return await context.app.inject({ method: 'POST', url, payload });
}

let counter = 0;
function freshPerson() {
  counter += 1;
  return {
    name: `Person ${counter}`,
    email: `person${counter}.${Date.now()}@example.com`,
    // A distinct, well-formed Nigerian mobile number per person.
    phone: `+23480${String(10_000_000 + counter).slice(0, 8)}`,
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
    expect(message?.subject).toMatch(/is your DASH verification code/);
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
    // Ordinary users hold no roles. Selling is a separate privileged state that
    // an admin still has to grant.
    expect(identity.roles).toEqual([]);
    expect(identity.customer?.declutterSeller).toBeNull();
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

    const again = await post('/v1/auth/signup', {
      name: 'Someone Else',
      email: person.email,
      phone: '+2348099999001',
    });
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

    await post('/v1/auth/signup', {
      name: 'Someone Else',
      email: person.email,
      phone: '+2348099999002',
    });

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

    await post('/v1/auth/signup', {
      name: 'Attacker',
      email: person.email,
      phone: '+2348099999003',
    });

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
  it('rejects a malformed email, a bad phone and a missing name', async () => {
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
