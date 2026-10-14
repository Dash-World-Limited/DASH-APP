/**
 * The support calls: which channels DASH offers, and the in-app chat in the
 * role the person is writing as.
 */

import { describe, expect, it } from 'vitest';

import type { ApiClient, RequestOptions } from '../api/client';
import { getSupportChannels, getSupportConversation, getSupportUnread, sendSupportMessage } from './support';

function fakeClient(answer: unknown) {
  const calls: { path: string; options: RequestOptions }[] = [];
  const api = {
    configured: true,
    request: async (path: string, options: RequestOptions = {}) => {
      calls.push({ path, options });
      return answer;
    },
  } as unknown as ApiClient;
  return { api, calls };
}

describe('support calls', () => {
  it('asks the server which channels exist', async () => {
    const { api, calls } = fakeClient({ whatsapp: null, chat: true });
    expect(await getSupportChannels(api)).toEqual({ whatsapp: null, chat: true });
    expect(calls[0]?.path).toBe('/v1/support/channels');
  });

  it('reads the conversation and unread count for the side of the app in use', async () => {
    const conversation = fakeClient({ conversation: null, messages: [] });
    await getSupportConversation(conversation.api, 'rider');
    expect(conversation.calls[0]?.path).toBe('/v1/support/chat?as=rider');

    const unread = fakeClient({ unread: 3 });
    expect(await getSupportUnread(unread.api, 'customer')).toBe(3);
    expect(unread.calls[0]?.path).toBe('/v1/support/chat/unread?as=customer');
  });

  it('sends a trimmed message as that side of the app', async () => {
    const message = { id: 'a1', from: 'me', body: 'Hello', readAt: null, createdAt: '2026-10-14T10:00:00.000Z' };
    const { api, calls } = fakeClient({ message });
    expect(await sendSupportMessage(api, 'customer', '  Hello  ')).toEqual(message);
    expect(calls).toEqual([{ path: '/v1/support/chat/messages', options: { method: 'POST', body: { as: 'customer', body: 'Hello' } } }]);
  });
});
