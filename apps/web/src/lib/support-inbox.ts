/**
 * The Super Admin support centre's view of in-app support conversations.
 *
 * Types mirror `/v1/admin/support/conversations`; the helpers are pure so the
 * wording and filters are tested without rendering.
 */

export type SupportAudience = 'customer' | 'rider';
export type AudienceFilter = SupportAudience | 'all';
export type StatusFilter = 'open' | 'resolved' | 'all';

export interface SupportAccount {
  role: SupportAudience;
  identityId: string;
  profileId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  accountStatus: string;
  riderStatus: string | null;
}

export interface SupportConversationSummary {
  id: string;
  code: string;
  status: string;
  audience: SupportAudience;
  account: SupportAccount | null;
  unread: number;
  lastMessage: { from: 'account' | 'staff'; preview: string; createdAt: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupportInbox {
  conversations: SupportConversationSummary[];
  unreadTotal: number;
}

export interface SupportThreadMessage {
  id: string;
  from: 'account' | 'staff';
  staffName: string | null;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export interface SupportThread {
  conversation: {
    id: string;
    code: string;
    status: string;
    audience: SupportAudience;
    account: SupportAccount | null;
    createdAt: string;
    updatedAt: string;
    firstRespondedAt: string | null;
  };
  messages: SupportThreadMessage[];
}

/** Matches the server's limit on a single message. */
export const SUPPORT_REPLY_MAX = 2000;

export function inboxPath(audience: AudienceFilter, status: StatusFilter): string {
  return `/v1/admin/support/conversations?audience=${audience}&status=${status}&limit=100`;
}

export function threadPath(id: string): string {
  return `/v1/admin/support/conversations/${encodeURIComponent(id)}`;
}

export const roleLabel = (role: SupportAudience): string => (role === 'rider' ? 'Rider' : 'Customer');

/** Who the conversation is with: their name, else email, else phone. */
export function accountName(account: SupportAccount | null): string {
  if (!account) return 'Account no longer available';
  return account.name?.trim() || account.email || account.phone || `${roleLabel(account.role)} account`;
}

/** The list's one-line preview, saying who wrote last. */
export function previewLine(conversation: Pick<SupportConversationSummary, 'lastMessage'>): string {
  const last = conversation.lastMessage;
  if (!last) return 'No messages yet';
  return last.from === 'staff' ? `DASH: ${last.preview}` : last.preview;
}

/** A time for today, a date otherwise. */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const when = new Date(iso);
  const sameDay = when.getFullYear() === now.getFullYear() && when.getMonth() === now.getMonth() && when.getDate() === now.getDate();
  return sameDay
    ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : when.toLocaleDateString([], { day: 'numeric', month: 'short', ...(when.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}
