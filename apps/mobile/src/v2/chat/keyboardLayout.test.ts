import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CHAT_KEYBOARD_BEHAVIOR, chatKeyboardDismissMode, keyboardOffsetFrom } from './keyboardLayout';

const screenSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'OrderChatScreen.tsx'), 'utf8');

describe('chat keyboard layout', () => {
  it('makes room for the keyboard on Android too', () => {
    // Edge-to-edge Android is never resized for the keyboard; leaving the
    // behaviour undefined there is what hid the composer on the Samsung A55.
    expect(CHAT_KEYBOARD_BEHAVIOR).toBe('padding');
    expect(screenSource).toContain('behavior={CHAT_KEYBOARD_BEHAVIOR}');
    expect(screenSource).not.toMatch(/behavior=\{Platform\.OS === 'ios' \? 'padding' : undefined\}/);
  });

  it('offsets by where the chat really starts, not a fixed height', () => {
    expect(screenSource).toContain('keyboardVerticalOffset={keyboardOffset}');
    expect(screenSource).toContain('measureInWindow');
    expect(keyboardOffsetFrom(36.4)).toBe(36);
    expect(keyboardOffsetFrom(0)).toBe(0);
    expect(keyboardOffsetFrom(-5)).toBe(0);
    expect(keyboardOffsetFrom(Number.NaN)).toBe(0);
  });

  it('keeps the conversation scrollable while typing on Android', () => {
    expect(chatKeyboardDismissMode('android')).toBe('none');
    expect(chatKeyboardDismissMode('ios')).toBe('interactive');
    expect(screenSource).toContain('keyboardShouldPersistTaps="handled"');
  });
});
