/**
 * How a one-time code reaches a person, kept apart from how it is made.
 *
 * Authentication owns generation, expiry and verification. This module owns
 * only the message that leaves DASH and hands it to the configured provider.
 */

import type { DeliveryReceipt, EmailPort, SmsPort } from '@dash/domain/ports';

export type OtpPurpose = 'login' | 'step_up';

export interface OtpMessage {
  code: string;
  ttlSeconds: number;
  purpose: OtpPurpose;
  displayName?: string | null;
}

export function otpReference(purpose: OtpPurpose): string {
  return `otp_${purpose}`;
}

function minutes(ttlSeconds: number): number {
  return Math.max(1, Math.round(ttlSeconds / 60));
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * One email identity for DASH authentication, regardless of which DASH product
 * initiated the journey. Product-specific wording here would make the shared
 * account feel like several unrelated accounts.
 */
export function otpEmailContent(message: OtpMessage): { subject: string; text: string; html: string } {
  const mins = minutes(message.ttlSeconds);
  const greeting = message.displayName ? `Hello ${message.displayName},` : 'Hello,';
  const htmlGreeting = message.displayName ? `Hello ${escapeHtml(message.displayName)},` : 'Hello,';
  const action = message.purpose === 'step_up' ? 'confirm this secure action' : 'continue with DASH';

  return {
    subject: `${message.code} is your DASH code`,
    text: `${greeting}\n\nYour DASH code is ${message.code}.\nUse it to ${action}. It expires in ${mins} minutes.\n\nNever share this code with anyone. DASH will never ask you to send it by phone, chat or social media.\n\nIf you did not request this code, you can safely ignore this email.\n\nDASH\nBeyond the Digital`,
    html: `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>Your DASH code</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${message.code} is your DASH code. It expires in ${mins} minutes.</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f4f6f9;padding:28px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #e5e7eb;">
            <tr>
              <td style="background:#0b1220;padding:26px 30px;">
                <div style="font-size:24px;font-weight:800;letter-spacing:-0.5px;color:#ffffff;">DASH<span style="color:#d8ad52;">.</span></div>
                <div style="margin-top:5px;font-size:11px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;color:#9ca3af;">Beyond the Digital</div>
              </td>
            </tr>
            <tr>
              <td style="padding:34px 30px 18px;">
                <div style="font-size:15px;line-height:24px;color:#4b5563;">${htmlGreeting}</div>
                <h1 style="margin:10px 0 8px;font-size:26px;line-height:34px;letter-spacing:-0.5px;color:#111827;">Your DASH code</h1>
                <p style="margin:0;font-size:15px;line-height:24px;color:#4b5563;">Use this code to ${action}. It expires in ${mins} minutes.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:4px 30px 26px;">
                <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:16px;padding:23px 18px;text-align:center;">
                  <div style="font-size:34px;line-height:40px;font-weight:800;letter-spacing:8px;color:#0b1220;">${message.code}</div>
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 30px 32px;">
                <div style="border-left:3px solid #d8ad52;padding:2px 0 2px 14px;font-size:13px;line-height:20px;color:#6b7280;">Never share this code. DASH will never ask you to send it by phone, chat or social media.</div>
                <p style="margin:20px 0 0;font-size:13px;line-height:20px;color:#6b7280;">If you did not request this code, you can safely ignore this email.</p>
              </td>
            </tr>
            <tr>
              <td style="border-top:1px solid #edf0f3;padding:20px 30px 24px;font-size:11px;line-height:18px;color:#9ca3af;">
                Sent securely by DASH · A Dash World product
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
  };
}

export function otpSmsBody(message: OtpMessage): string {
  return `Your DASH code is ${message.code}. It expires in ${minutes(message.ttlSeconds)} minutes. Never share this code.`;
}

export function sendOtpEmail(email: EmailPort, to: string, message: OtpMessage): Promise<DeliveryReceipt> {
  return email.send({ to, ...otpEmailContent(message), reference: otpReference(message.purpose) });
}

export function sendOtpSms(sms: SmsPort, to: string, message: OtpMessage): Promise<DeliveryReceipt> {
  return sms.send({ to, body: otpSmsBody(message), reference: otpReference(message.purpose) });
}

/**
 * Provider errors may contain recipient/body data. Only the class and a safe
 * machine code are allowed into logs.
 */
export function describeDeliveryFailure(error: unknown): { errorName: string; errorCode?: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { errorName: error.name, ...(typeof code === 'string' ? { errorCode: code } : {}) };
  }
  return { errorName: typeof error };
}
