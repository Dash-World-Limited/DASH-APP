/**
 * How a one-time code reaches a person, kept apart from how it is made.
 *
 * Generating, hashing, expiring, counting attempts and consuming a code live
 * in the OTP routes and `@dash/domain/crypto`. This file only words the
 * message and hands it to whichever provider is configured behind `EmailPort`
 * or `SmsPort`. So moving off Amazon SES (still sandboxed: it will deliver only
 * to verified addresses until AWS approves production access) to another
 * transactional email provider is an adapter change. Nothing here, and nothing
 * in authentication, has to be rewritten.
 *
 * The message body is the code. Nothing in this file logs, and callers must
 * not log what these functions return or throw beyond the provider's error
 * name: the adapters are built never to echo a body back.
 */

import type { DeliveryReceipt, EmailPort, SmsPort } from '@dash/domain/ports';

export type OtpPurpose = 'login' | 'step_up';

export interface OtpMessage {
  code: string;
  ttlSeconds: number;
  purpose: OtpPurpose;
  /** Greets the person by name when the account has one. */
  displayName?: string | null;
}

/** The delivery reference, which also marks the mail essential to the suppression layer. */
export function otpReference(purpose: OtpPurpose): string {
  return `otp_${purpose}`;
}

function minutes(ttlSeconds: number): number {
  return Math.max(1, Math.round(ttlSeconds / 60));
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** A display name is user-supplied text; it must never become markup in an email. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

export function otpEmailContent(message: OtpMessage): { subject: string; text: string; html: string } {
  const mins = minutes(message.ttlSeconds);
  const greeting = message.displayName ? `Hello ${message.displayName},` : 'Hello,';
  const htmlGreeting = message.displayName ? `Hello ${escapeHtml(message.displayName)},` : 'Hello,';
  return {
    subject: `${message.code} is your DASH sign-in code`,
    text: `${greeting}\n\nYour DASH sign-in code is ${message.code}.\nIt expires in ${mins} minutes.\n\nIf you did not try to sign in, ignore this email. Nobody can use this code without it.\n\nDASH World Limited`,
    html: `<p>${htmlGreeting}</p><p>Your DASH sign-in code is <strong style="font-size:20px;letter-spacing:2px">${message.code}</strong></p><p>It expires in ${mins} minutes.</p><p>If you did not try to sign in, ignore this email. Nobody can use this code without it.</p><p>DASH World Limited</p>`,
  };
}

export function otpSmsBody(message: OtpMessage): string {
  return `Your DASH APP code is ${message.code}. It expires in ${minutes(message.ttlSeconds)} minutes.`;
}

/** Send a sign-in or step-up code by email, through whatever provider is configured. */
export function sendOtpEmail(email: EmailPort, to: string, message: OtpMessage): Promise<DeliveryReceipt> {
  return email.send({ to, ...otpEmailContent(message), reference: otpReference(message.purpose) });
}

/** Send a sign-in or step-up code by SMS, through whatever provider is configured. */
export function sendOtpSms(sms: SmsPort, to: string, message: OtpMessage): Promise<DeliveryReceipt> {
  return sms.send({ to, body: otpSmsBody(message), reference: otpReference(message.purpose) });
}

/**
 * What may be recorded about a failed delivery: the provider's error class and
 * code, never its message (which can quote the request) and never the body.
 */
export function describeDeliveryFailure(error: unknown): { errorName: string; errorCode?: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { errorName: error.name, ...(typeof code === 'string' ? { errorCode: code } : {}) };
  }
  return { errorName: typeof error };
}
