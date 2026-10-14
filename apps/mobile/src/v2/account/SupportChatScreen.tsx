/**
 * Chat with the DASH team, for customers and riders.
 *
 * One conversation per person per side of the app. Messages are kept on the
 * server; the screen polls while it is open, like the order chat, and opening
 * it marks the team's replies read. The composer uses KeyboardSafeView — the
 * pattern that fixed the order chat on Android — so it stays above the
 * keyboard on edge-to-edge screens with either navigation style.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';

import { api, ApiError } from '../../api';
import { getSupportConversation, sendSupportMessage, type SupportMessage } from '../../data/support';
import type { SupportAudience } from '../../features/support';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, space } from '../../theme/tokens';
import { Icon } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useAppSession } from '../auth/AppSessionProvider';
import { chatKeyboardDismissMode } from '../chat/keyboardLayout';
import { KeyboardSafeView } from '../chat/KeyboardSafeView';
import { BackHeader, Empty, Notice } from '../orders/parts';

const POLL_MS = 5_000;
const BODY_MAX = 2_000;

const describeError = (error: unknown, fallback: string): string =>
  error instanceof ApiError ? (error.isNetwork ? 'DASH could not be reached. Check your connection and try again.' : error.message) : fallback;

export function SupportChatScreen({ audience, onBack }: { audience: SupportAudience; onBack: () => void }) {
  const { palette } = useTheme();
  const { state: sessionState } = useAppSession();
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<ScrollView | null>(null);
  const sendingRef = useRef(false);

  const signedIn = api.configured && sessionState === 'authenticated';

  const load = useCallback(
    async (quiet = false) => {
      if (!signedIn) {
        setBusy(false);
        return;
      }
      try {
        const response = await getSupportConversation(api, audience);
        setMessages(response.messages);
        setCode(response.conversation?.code ?? null);
        if (!quiet) setError(null);
      } catch (caught) {
        if (!quiet) setError(describeError(caught, 'Could not load your conversation with DASH.'));
      } finally {
        setBusy(false);
      }
    },
    [audience, signedIn],
  );

  useEffect(() => {
    void load();
    if (!signedIn) return;
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void load(true);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load, signedIn]);

  useEffect(() => {
    if (messages.length > 0) requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated: true }));
  }, [messages.length]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      const message = await sendSupportMessage(api, audience, body);
      setDraft('');
      setMessages((current) => [...current, message]);
      if (!code) void load(true);
    } catch (caught) {
      setError(describeError(caught, 'Your message could not be sent. Please try again.'));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  if (!signedIn) {
    return (
      <View style={{ flex: 1, backgroundColor: palette.background, paddingHorizontal: space.gutter }}>
        <BackHeader title="Chat with DASH" onBack={onBack} />
        <Empty
          icon="account-lock-outline"
          title="Sign in to chat with DASH"
          body={api.configured ? 'Your conversation with the DASH team belongs to your account.' : 'This build is not connected to DASH.'}
        />
      </View>
    );
  }

  const canSend = draft.trim().length > 0 && !sending;

  return (
    <KeyboardSafeView testID={`${audience}-support-chat-v2`} style={{ backgroundColor: palette.background }}>
      <View style={{ paddingHorizontal: space.gutter }}>
        <BackHeader title="Chat with DASH" onBack={onBack} />
        {code ? <Text variant="micro" tone="muted">Conversation {code}</Text> : null}
      </View>

      {busy ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={palette.accent} accessibilityLabel="Loading your conversation" />
        </View>
      ) : (
        <ScrollView
          ref={scroll}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: space.gutter, paddingVertical: space.lg, gap: space.sm }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={chatKeyboardDismissMode(Platform.OS)}
        >
          {messages.length === 0 && !error ? (
            <Empty
              icon="message-text-outline"
              title="How can we help?"
              body={
                audience === 'rider'
                  ? 'Write to the DASH team about deliveries, earnings or your rider account. We reply here.'
                  : 'Write to the DASH team about an order, a payment or your account. We reply here.'
              }
            />
          ) : null}
          {messages.map((message) => (
            <Bubble key={message.id} message={message} />
          ))}
          {error ? <Notice icon="alert-circle-outline" text={error} danger /> : null}
        </ScrollView>
      )}

      <View style={{ padding: space.gutter, borderTopWidth: 1, borderTopColor: palette.line, backgroundColor: palette.surface }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.sm }}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            editable={!sending}
            maxLength={BODY_MAX}
            multiline
            placeholder="Write to the DASH team…"
            placeholderTextColor={palette.textSubtle}
            accessibilityLabel="Message to DASH support"
            testID="support-chat-input"
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
            disabled={!canSend}
            onPress={() => void send()}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityState={{ disabled: !canSend }}
            testID="support-chat-send"
            style={({ pressed }) => ({
              width: 48,
              height: 48,
              borderRadius: 24,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: canSend ? 1 : 0.45,
              backgroundColor: pressed ? palette.accentPressed : palette.accent,
            })}
          >
            {sending ? <ActivityIndicator color={palette.onAccent} /> : <Icon name="send" color={palette.onAccent} />}
          </Pressable>
        </View>
      </View>
    </KeyboardSafeView>
  );
}

function Bubble({ message }: { message: SupportMessage }) {
  const { palette } = useTheme();
  const mine = message.from === 'me';
  const time = new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <View
      style={{
        maxWidth: '82%',
        alignSelf: mine ? 'flex-end' : 'flex-start',
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        borderRadius: radius.lg,
        backgroundColor: mine ? palette.accent : palette.surface,
        borderWidth: mine ? 0 : 1,
        borderColor: palette.line,
        gap: 2,
      }}
    >
      {mine ? null : <Text variant="micro" weight="bold" tone="accent">DASH Support</Text>}
      <Text variant="caption" tone={mine ? 'onAccent' : 'default'}>{message.body}</Text>
      <Text variant="micro" style={{ color: mine ? palette.onAccent : palette.textSubtle, opacity: 0.8 }}>
        {time}
        {mine ? (message.readAt ? ' · Read' : ' · Sent') : ''}
      </Text>
    </View>
  );
}
