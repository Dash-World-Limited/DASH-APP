/**
 * One-time codes: the provider seam, the per-destination throttle, and what
 * a failed delivery may and may not reveal.
 *
 * Adversarial by design. Each throttle and failure path is compared byte for
 * byte against the answer for a number with no account, because every one of
 * them happens only for a real account and would otherwise say so.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeliveryReceipt, EmailPort, SmsPort } from '@dash/domain/ports';
import { createTestContext, TEST_EMAIL, TEST_PHONE, type TestContext } from './harness.js';
import { describeDeliveryFailure, otpEmailContent, otpSmsBody } from '../auth/otp-delivery.js';

const UNKNOWN_PHONE = '+2347000009999';

class CapturingSms implements SmsPort {
  readonly providerName = 'capture';
  readonly isLive = false;
  readonly sent: Array<{ to: string; body: string; reference: string }> = [];
  fail = false;

  async send(input: { to: string; body: string; reference: string }): Promise<DeliveryReceipt> {
    if (this.fail) {
      // Like a careless provider, the error quotes the message it refused.
      const error = new Error(`provider refused: ${input.body}`);
      error.name = 'MessageRejected';
      throw error;
    }
    this.sent.push(input);
    return { accepted: true, providerMessageId: `sms_${this.sent.length}` };
  }
}

class CapturingEmail implements EmailPort {
  readonly providerName = 'capture';
  readonly isLive = false;
  readonly sent: Array<{ to: string; subject: string; text: string; html: string; reference: string }> = [];

  async send(input: { to: string; subject: string; text: string; html: string; reference: string }): Promise<DeliveryReceipt> {
    this.sent.push(input);
    return { accepted: true, providerMessageId: `email_${this.sent.length}` };
  }
}

/** The response without the development-only code, which only ever exists for a real account. */
function publicShape(raw: string): string {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  delete parsed['devCode'];
  return JSON.stringify(parsed);
}

async function requestCode(context: TestContext, payload: Record<string, string>) {
  return context.app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload });
}

// ---------------------------------------------------------------------------
describe('the message, apart from the provider', () => {
  it('carries the code and its expiry in every part of the email', () => {
    const content = otpEmailContent({ code: '048213', ttlSeconds: 300, purpose: 'login', displayName: 'Ada' });
    expect(content.subject).toBe('048213 is your DASH sign-in code');
    expect(content.text).toContain('048213');
    expect(content.text).toContain('5 minutes');
    expect(content.text.startsWith('Hello Ada,')).toBe(true);
    expect(content.html).toContain('048213');
  });

  it('never lets a display name become markup in the email', () => {
    const content = otpEmailContent({
      code: '111111',
      ttlSeconds: 300,
      purpose: 'login',
      displayName: '<img src=x onerror="steal()">',
    });
    expect(content.html).not.toContain('<img');
    expect(content.html).toContain('&lt;img src=x onerror=&quot;steal()&quot;&gt;');
  });

  it('greets someone with no name plainly, and words the SMS with the code', () => {
    expect(otpEmailContent({ code: '222222', ttlSeconds: 600, purpose: 'login' }).text.startsWith('Hello,')).toBe(true);
    expect(otpSmsBody({ code: '333333', ttlSeconds: 600, purpose: 'step_up' })).toBe(
      'Your DASH APP code is 333333. It expires in 10 minutes.',
    );
  });

  it('describes a failure by its name and code only, never its message', () => {
    const error = Object.assign(new Error('refused: Your DASH APP code is 444444'), { name: 'MessageRejected', code: 'E1' });
    expect(describeDeliveryFailure(error)).toEqual({ errorName: 'MessageRejected', errorCode: 'E1' });
    expect(JSON.stringify(describeDeliveryFailure(error))).not.toContain('444444');
  });
});

// ---------------------------------------------------------------------------
describe('per-destination cooldown', () => {
  let context: TestContext;
  const sms = new CapturingSms();
  const email = new CapturingEmail();

  beforeAll(async () => {
    context = await createTestContext(
      { OTP_RESEND_COOLDOWN_SECONDS: '60', OTP_MAX_CODES_PER_HOUR: '5' },
      { sms, email },
    );
  }, 120_000);
  afterAll(async () => context?.close());

  it('sends once, then holds for the cooldown, and the first code still works', async () => {
    const first = await requestCode(context, { phone: TEST_PHONE });
    const code = first.json<{ devCode?: string }>().devCode;
    expect(code).toMatch(/^\d{6}$/);
    expect(sms.sent).toHaveLength(1);

    const again = await requestCode(context, { phone: TEST_PHONE });
    expect(again.statusCode).toBe(200);
    expect(sms.sent).toHaveLength(1); // nothing sent inside the cooldown
    expect(again.json<{ devCode?: string }>().devCode).toBeUndefined();

    const verify = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { phone: TEST_PHONE, code },
    });
    expect(verify.statusCode).toBe(200);
  });

  it('answers a held request exactly like a number with no account', async () => {
    const held = await requestCode(context, { phone: TEST_PHONE });
    const unknown = await requestCode(context, { phone: UNKNOWN_PHONE });
    expect(held.statusCode).toBe(unknown.statusCode);
    expect(publicShape(held.body)).toBe(publicShape(unknown.body));
  });

  it('tells every caller the same resend delay, account or not', async () => {
    const unknown = await requestCode(context, { phone: '+2347000009998' });
    expect(unknown.json<{ resendAfterSeconds: number }>().resendAfterSeconds).toBe(60);
  });

  it('emails a verified address through the email port, not the SMS one', async () => {
    await context.prisma.identity.update({ where: { id: context.identityId }, data: { emailVerifiedAt: new Date() } });
    const response = await requestCode(context, { email: TEST_EMAIL });
    const code = response.json<{ devCode?: string }>().devCode;
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe(TEST_EMAIL);
    expect(email.sent[0]?.subject).toBe(`${code} is your DASH sign-in code`);
    expect(email.sent[0]?.reference).toBe('otp_login');
  });
});

// ---------------------------------------------------------------------------
describe('hourly cap per destination', () => {
  let context: TestContext;
  const sms = new CapturingSms();

  beforeAll(async () => {
    context = await createTestContext({ OTP_RESEND_COOLDOWN_SECONDS: '0', OTP_MAX_CODES_PER_HOUR: '2' }, { sms });
  }, 120_000);
  afterAll(async () => context?.close());

  it('stops sending to one destination after the cap, however many requests arrive', async () => {
    for (let i = 0; i < 4; i += 1) {
      const response = await requestCode(context, { phone: TEST_PHONE });
      expect(response.statusCode).toBe(200);
    }
    expect(sms.sent).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
describe('a delivery that fails', () => {
  let context: TestContext;
  const sms = new CapturingSms();
  const logs: string[] = [];

  beforeAll(async () => {
    sms.fail = true;
    context = await createTestContext({ LOG_LEVEL: 'info' }, { sms }, { write: (chunk) => void logs.push(chunk) });
  }, 120_000);
  afterAll(async () => context?.close());

  it('is answered like any other request, so it cannot reveal the account', async () => {
    const failed = await requestCode(context, { phone: TEST_PHONE });
    const unknown = await requestCode(context, { phone: UNKNOWN_PHONE });
    expect(failed.statusCode).toBe(200);
    expect(failed.json<{ devCode?: string }>().devCode).toBeUndefined();
    expect(publicShape(failed.body)).toBe(publicShape(unknown.body));
  });

  it('leaves no code that could be used', async () => {
    const outstanding = await context.prisma.otpChallenge.count({
      where: { destination: TEST_PHONE, consumedAt: null },
    });
    expect(outstanding).toBe(0);
  });

  it('is logged by provider and error name, never with the message or the code', () => {
    const joined = logs.join('\n');
    expect(joined).toContain('otp delivery failed');
    expect(joined).toContain('MessageRejected');
    expect(joined).not.toContain('provider refused');
    expect(joined).not.toContain('Your DASH APP code');
  });
});
