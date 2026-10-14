/**
 * How to reach DASH.
 *
 * Only channels DASH actually answers on: email at the official DASH World
 * address, always; WhatsApp when the server names an official number (it is
 * configured on the API, never built into the app, so no placeholder or
 * borrowed line is ever shown); and chat with the DASH team inside the app.
 *
 * Pure: tested directly.
 */

export const DASH_SUPPORT_EMAIL = 'info@dashworldng.com';

export type SupportAudience = 'customer' | 'rider';

export type SupportChannel =
  | { kind: 'email'; address: string }
  /** WhatsApp, in E.164. Added once DASH has a support line of its own. */
  | { kind: 'whatsapp'; number: string }
  /** Chat with the DASH team inside the app. Added with the support desk. */
  | { kind: 'chat' };

export const SUPPORT_CHANNELS: readonly SupportChannel[] = [{ kind: 'email', address: DASH_SUPPORT_EMAIL }];

/**
 * A `mailto:` that arrives at DASH already saying who is writing and what
 * would help: the side of the app, the account's sign-in email when there is
 * one, and room for an order code.
 */
export function supportMailto(address: string, audience: SupportAudience, accountEmail?: string | null): string {
  const subject = `DASH App help (${audience === 'rider' ? 'Rider' : 'Customer'})`;
  const lines = ['Order code (if this is about an order):', '', 'What happened:', '', '', '—', 'Sent from the DASH app'];
  if (accountEmail) lines.push(`Account: ${accountEmail}`);
  return `mailto:${address}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
}

/**
 * `https://wa.me/<digits>`, optionally with a first message already typed, so
 * the chat opens in WhatsApp ready to send.
 */
export function whatsappUrl(e164: string, text?: string): string {
  const base = `https://wa.me/${e164.replace(/\D/g, '')}`;
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
}

const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Every way to reach DASH right now, in the order the Help screen lists them:
 * in-app chat first when it can be opened, then WhatsApp when the server
 * named a valid official number, then email, which is always there.
 */
export function supportChannels(available: { whatsapp: string | null; chat: boolean }): SupportChannel[] {
  const channels: SupportChannel[] = [];
  if (available.chat) channels.push({ kind: 'chat' });
  if (available.whatsapp && E164.test(available.whatsapp)) channels.push({ kind: 'whatsapp', number: available.whatsapp });
  channels.push(...SUPPORT_CHANNELS);
  return channels;
}

/** The first WhatsApp message, saying which side of the app is asking. */
export function whatsappGreeting(audience: SupportAudience): string {
  return audience === 'rider' ? 'Hello DASH support, I am a DASH rider and I need help.' : 'Hello DASH support, I need help with my DASH order or account.';
}
