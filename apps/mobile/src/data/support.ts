/**
 * Support: the channels the server offers, and the in-app chat with the DASH
 * team. `as` says which side of the app is writing — a rider who is also a
 * customer has a conversation for each.
 */

import type { ApiClient } from '../api/client';
import type { SupportAudience } from '../features/support';

export interface SupportChannelsResponse {
  whatsapp: string | null;
  chat: boolean;
}

export interface SupportMessage {
  id: string;
  /** `me` is the person using the app; `dash` is the DASH team. */
  from: 'me' | 'dash';
  body: string;
  /** For `me`: when the DASH team read it. */
  readAt: string | null;
  createdAt: string;
}

export interface SupportConversation {
  conversation: { id: string; code: string; status: string; createdAt: string } | null;
  messages: SupportMessage[];
}

export function getSupportChannels(api: ApiClient): Promise<SupportChannelsResponse> {
  return api.request<SupportChannelsResponse>('/v1/support/channels');
}

export function getSupportConversation(api: ApiClient, as: SupportAudience): Promise<SupportConversation> {
  return api.request<SupportConversation>(`/v1/support/chat?as=${as}`);
}

export async function getSupportUnread(api: ApiClient, as: SupportAudience): Promise<number> {
  return (await api.request<{ unread: number }>(`/v1/support/chat/unread?as=${as}`)).unread;
}

export async function sendSupportMessage(api: ApiClient, as: SupportAudience, body: string): Promise<SupportMessage> {
  return (await api.request<{ message: SupportMessage }>('/v1/support/chat/messages', { method: 'POST', body: { as, body: body.trim() } })).message;
}
