/**
 * How to reach DASH.
 *
 * Only channels DASH actually answers on. Today that is email, at the
 * official DASH World address. WhatsApp support and chat with the DASH team
 * are planned; each joins `SUPPORT_CHANNELS` when it has a real number or a
 * staffed desk behind it — never a placeholder, and never a number borrowed
 * from another team's line.
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

/** `https://wa.me/<digits>`, for when DASH has a WhatsApp support number. */
export function whatsappUrl(e164: string): string {
  return `https://wa.me/${e164.replace(/\D/g, '')}`;
}
