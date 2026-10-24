import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeliveryReceipt, EmailPort } from '@dash/domain/ports';
import { PRIVACY_SLUG, TERMS_SLUG, seedLegalDocuments } from '@dash/db';
import { createTestContext, type TestContext } from './harness.js';
import { useIntegrationTimeouts } from './timeouts.js';

useIntegrationTimeouts();

interface CapturedEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  reference: string;
}

class CapturingEmailAdapter implements EmailPort {
  readonly providerName = 'capture';
  readonly isLive = false;
  readonly sent: CapturedEmail[] = [];

  async send(input: CapturedEmail): Promise<DeliveryReceipt> {
    this.sent.push(input);
    return { accepted: true, providerMessageId: `capture_${this.sent.length}` };
  }

  lastTo(address: string): CapturedEmail | null {
    return [...this.sent].reverse().find((message) => message.to === address) ?? null;
  }
}

const mailbox = new CapturingEmailAdapter();
let context: TestContext;

beforeAll(async () => {
  context = await createTestContext({}, { email: mailbox });
  await seedLegalDocuments(context.prisma);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

async function post(url: string, payload: Record<string, unknown>) {
  return await context.app.inject({ method: 'POST', url, payload });
}

let counter = 0;
function person(overrides: Record<string, unknown> = {}) {
  counter += 1;
  return {
    name: `Brand Test ${counter}`,
    email: `brand-test-${counter}-${Date.now()}@example.com`,
    phone: `+23480${String(20_000_000 + counter).slice(0, 8)}`,
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

async function createVerifiedAccount(overrides: Record<string, unknown> = {}) {
  const account = person(overrides);
  const signup = await post('/v1/auth/signup', account);
  expect(signup.statusCode).toBe(200);
  expect(signup.json().devCode).toMatch(/^\d{6}$/);

  const verified = await post('/v1/auth/email/verify', {
    email: account.email,
    code: signup.json().devCode,
  });
  expect(verified.statusCode).toBe(200);
  return account;
}

describe('signup account-notice email branding', () => {
  it('uses the shared DASH branded layout for an existing-email notice', async () => {
    const existing = await createVerifiedAccount();

    const retry = person({
      name: 'Different Name',
      email: existing.email,
    });
    const response = await post('/v1/auth/signup', retry);
    expect(response.statusCode).toBe(200);

    const message = mailbox.lastTo(existing.email as string);
    expect(message?.subject).toBe('You already have a DASH account');
    expect(message?.reference).toBe('signup_existing_account');
    expect(message?.html).toContain('DASH<span');
    expect(message?.html).toContain('Beyond the Digital');
    expect(message?.html).toContain('A Dash World product');
    expect(message?.html).toContain('You already have a DASH account');
  });

  it('brands phone-conflict notices, directs sign-in to email, and reveals no existing-account details', async () => {
    const owner = await createVerifiedAccount({ name: 'Existing Owner' });
    const blocked = person({ name: 'Blocked Applicant' });

    const response = await post('/v1/auth/signup', {
      ...blocked,
      phone: owner.phone,
    });
    expect(response.statusCode).toBe(200);

    const message = mailbox.lastTo(blocked.email as string);
    expect(message?.subject).toBe('We could not finish creating your DASH account');
    expect(message?.reference).toBe('signup_phone_conflict');
    expect(message?.text).toContain(
      'sign in using the email address already linked to your DASH account',
    );
    expect(message?.text).not.toContain('sign in with that phone number');
    expect(message?.text).toContain('reply to this email or contact DASH support');

    expect(message?.html).toContain('DASH<span');
    expect(message?.html).toContain('Beyond the Digital');
    expect(message?.html).toContain('A Dash World product');
    expect(message?.html).toContain('We could not create another DASH account');
    expect(message?.html).not.toContain('sign in with that phone number');

    expect(message?.text).not.toContain(owner.email as string);
    expect(message?.text).not.toContain(owner.name as string);
    expect(message?.html).not.toContain(owner.email as string);
    expect(message?.html).not.toContain(owner.name as string);
  });
});

// Keep imports above tied to seeded documents so tree-shaking/typecheck cannot
// accidentally hide that signup depends on current legal versions.
void PRIVACY_SLUG;
void TERMS_SLUG;
