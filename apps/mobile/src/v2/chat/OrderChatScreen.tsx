import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';

import { api, ApiError } from '../../api';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, space } from '../../theme/tokens';
import { Icon } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useAppSession } from '../auth/AppSessionProvider';
import { BackHeader, Empty, Notice } from '../orders/parts';

interface ChatMessage {
  id: string;
  senderRole: 'customer' | 'rider';
  body: string;
  mine: boolean;
  readAt: string | null;
  createdAt: string;
}

interface ChatResponse {
  orderId: string;
  canSend: boolean;
  messages: ChatMessage[];
}

export function OrderChatScreen({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const { palette } = useTheme();
  const auth = useAppSession();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [canSend, setCanSend] = useState(true);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(api.configured);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<ScrollView | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!api.configured || auth.state !== 'authenticated' || !orderId) {
      if (!quiet) setBusy(false);
      return;
    }
    if (!quiet) setBusy(true);
    try {
      const response = await api.request<ChatResponse>(`/v1/orders/${encodeURIComponent(orderId)}/chat`);
      setMessages(response.messages);
      setCanSend(response.canSend);
      setError(null);
    } catch (caught) {
      if (!quiet) {
        setError(caught instanceof ApiError ? caught.message : 'Could not load this conversation.');
      }
    } finally {
      if (!quiet) setBusy(false);
    }
  }, [auth.state, orderId]);

  useEffect(() => {
    void load();
    if (!api.configured || auth.state !== 'authenticated' || !orderId) return;
    const timer = setInterval(() => void load(true), 4_000);
    return () => clearInterval(timer);
  }, [auth.state, load, orderId]);

  useEffect(() => {
    if (messages.length > 0) {
      requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated: true }));
    }
  }, [messages.length]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending || !canSend) return;
    setSending(true);
    setError(null);
    try {
      const message = await api.request<ChatMessage>(
        `/v1/orders/${encodeURIComponent(orderId)}/chat/messages`,
        { method: 'POST', body: { body } },
      );
      setDraft('');
      setMessages((current) => [...current, message]);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not send that message.');
    } finally {
      setSending(false);
    }
  };

  if (!api.configured) {
    return (
      <View style={{ flex: 1, backgroundColor: palette.background, paddingHorizontal: space.gutter }}>
        <BackHeader title="Order chat" onBack={onBack} />
        <Empty icon="cloud-off-outline" title="Not connected to DASH" body="Chat needs the DASH API connection." />
      </View>
    );
  }

  if (auth.state !== 'authenticated') {
    return (
      <View style={{ flex: 1, backgroundColor: palette.background, paddingHorizontal: space.gutter }}>
        <BackHeader title="Order chat" onBack={onBack} />
        <Empty icon="account-lock-outline" title="Sign in to chat" body="Only the customer and assigned rider can open this conversation." />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: palette.background }}>
      <View style={{ paddingHorizontal: space.gutter }}>
        <BackHeader title="Order chat" onBack={onBack} />
      </View>

      {busy ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={palette.accent} />
        </View>
      ) : (
        <ScrollView
          ref={scroll}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: space.gutter, paddingVertical: space.lg, gap: space.sm }}
          showsVerticalScrollIndicator={false}
        >
          {messages.length === 0 && !error ? (
            <Empty
              icon="message-text-outline"
              title="Start the conversation"
              body="Only you and the rider or customer assigned to this order can see messages here."
            />
          ) : null}
          {messages.map((message) => (
            <View
              key={message.id}
              style={{
                maxWidth: '82%',
                alignSelf: message.mine ? 'flex-end' : 'flex-start',
                paddingHorizontal: space.md,
                paddingVertical: space.sm,
                borderRadius: radius.lg,
                backgroundColor: message.mine ? palette.accent : palette.surface,
                borderWidth: message.mine ? 0 : 1,
                borderColor: palette.line,
                gap: 2,
              }}
            >
              <Text variant="caption" tone={message.mine ? 'onAccent' : 'default'}>{message.body}</Text>
              <Text
                variant="micro"
                style={{ color: message.mine ? palette.onAccent : palette.textSubtle, opacity: 0.8 }}
              >
                {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </Text>
            </View>
          ))}
          {error ? <Notice icon="alert-circle-outline" text={error} danger /> : null}
        </ScrollView>
      )}

      <View style={{ padding: space.gutter, borderTopWidth: 1, borderTopColor: palette.line, backgroundColor: palette.surface }}>
        {!canSend ? <Text variant="micro" tone="muted">This completed order’s conversation is read-only.</Text> : null}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.sm }}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            editable={canSend && !sending}
            maxLength={1000}
            multiline
            placeholder={canSend ? 'Message about this order…' : 'Conversation closed'}
            placeholderTextColor={palette.textSubtle}
            accessibilityLabel="Chat message"
            style={{
              flex: 1,
              minHeight: 48,
              maxHeight: 120,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: palette.line,
              backgroundColor: palette.background,
              color: palette.text,
              paddingHorizontal: space.md,
              paddingVertical: space.sm,
              fontFamily: 'Manrope_500Medium',
              fontSize: 14,
            }}
          />
          <Pressable
            disabled={!canSend || sending || draft.trim().length === 0}
            onPress={() => void send()}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            style={({ pressed }) => ({
              width: 48,
              height: 48,
              borderRadius: 24,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: !canSend || sending || draft.trim().length === 0 ? 0.45 : 1,
              backgroundColor: pressed ? palette.accentPressed : palette.accent,
            })}
          >
            {sending ? <ActivityIndicator color={palette.onAccent} /> : <Icon name="send" color={palette.onAccent} />}
          </Pressable>
        </View>
      </View>
    </View>
  );
}
