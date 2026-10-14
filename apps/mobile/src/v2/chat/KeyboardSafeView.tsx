/**
 * A screen area that keeps its bottom edge above the software keyboard.
 *
 * The same pattern that fixed the order chat (see keyboardLayout.ts), as one
 * component so every screen with a bottom-anchored input uses it the same
 * way: a KeyboardAvoidingView with `padding`, offset by where this area really
 * starts in the window — measured, never a hard-coded height — so it stays
 * right under the status bar, a banner, or anything else above it.
 *
 * The navigation-bar inset (gesture or three-button) is left to the root
 * SafeAreaView, as it is for the chat.
 */

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, View, type StyleProp, type ViewStyle } from 'react-native';

import { CHAT_KEYBOARD_BEHAVIOR, keyboardOffsetFrom } from './keyboardLayout';

export function KeyboardSafeView({
  children,
  style,
  testID,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const frame = useRef<View | null>(null);
  const [offset, setOffset] = useState(0);
  const measure = useCallback(() => {
    frame.current?.measureInWindow((_x, y) => setOffset(keyboardOffsetFrom(y)));
  }, []);

  return (
    <View ref={frame} onLayout={measure} testID={testID} style={[{ flex: 1 }, style]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={CHAT_KEYBOARD_BEHAVIOR} keyboardVerticalOffset={offset}>
        {children}
      </KeyboardAvoidingView>
    </View>
  );
}
