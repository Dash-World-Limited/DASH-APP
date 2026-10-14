/**
 * The support chat keeps its composer above the keyboard the same way the
 * order chat and the delivery PIN do, and the Help screens open it and
 * WhatsApp from the server's channels rather than anything built in.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const chat = readFileSync(join(here, 'SupportChatScreen.tsx'), 'utf8');
const help = readFileSync(join(here, 'SupportScreen.tsx'), 'utf8');

describe('the support chat screen', () => {
  it('sits inside KeyboardSafeView, with the composer inside it', () => {
    expect(chat).toMatch(/<KeyboardSafeView testID=\{`\$\{audience\}-support-chat-v2`\}/);
    const opened = chat.indexOf('<KeyboardSafeView');
    const closed = chat.indexOf('</KeyboardSafeView>');
    const input = chat.indexOf('testID="support-chat-input"');
    const send = chat.indexOf('testID="support-chat-send"');
    expect(opened).toBeGreaterThan(-1);
    expect(input).toBeGreaterThan(opened);
    expect(send).toBeGreaterThan(input);
    expect(closed).toBeGreaterThan(send);
  });

  it('does not add a second keyboard handler or a hard-coded offset', () => {
    expect(chat).not.toContain('KeyboardAvoidingView');
    expect(chat).not.toMatch(/keyboardVerticalOffset/);
  });

  it('guards against sending twice and keeps messages within the server limit', () => {
    expect(chat).toContain('if (!body || sendingRef.current) return;');
    expect(chat).toContain('maxLength={BODY_MAX}');
    expect(chat).toContain('const BODY_MAX = 2_000;');
  });
});

describe('the Help screens', () => {
  it('list channels from the server, keep email, and open WhatsApp with a greeting', () => {
    expect(help).toContain('supportChannels(');
    expect(help).toContain('getSupportChannels(');
    expect(help).toContain('whatsappUrl(');
    expect(help).toContain('whatsappGreeting(');
    expect(help).toContain('supportMailto(');
    expect(help).toContain('testID="support-whatsapp"');
    expect(help).toContain('testID="support-chat"');
  });
});
