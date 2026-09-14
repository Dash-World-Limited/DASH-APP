/**
 * Text entry: a labelled field, and the six-box field for a one-time code.
 *
 * Both follow the search field's surface (same radius, ground and edge) so
 * forms read as the same family. Focus is shown with the bronze edge, errors
 * with the danger edge and a line of text beneath, never with colour alone.
 */

import { useRef, useState } from 'react';
import { Pressable, TextInput, View, type TextInputProps } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { fontFamily, radius, space, typeScale } from '../theme/tokens';
import { Text } from './Text';

type Passthrough = Pick<
  TextInputProps,
  'keyboardType' | 'autoComplete' | 'textContentType' | 'autoCapitalize' | 'autoCorrect' | 'returnKeyType' | 'onSubmitEditing' | 'autoFocus' | 'editable'
>;

export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  hint,
  error,
  testID,
  ...input
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  /** A line of help under the field when there is no error. */
  hint?: string;
  error?: string | null;
  testID?: string;
} & Passthrough) {
  const { palette } = useTheme();
  const [focused, setFocused] = useState(false);
  const edge = error ? palette.danger : focused ? palette.accent : palette.edge;
  return (
    <View style={{ gap: space.xs }}>
      <Text variant="label">{label}</Text>
      <View
        style={{
          minHeight: 50,
          borderRadius: radius.md,
          backgroundColor: palette.surface,
          borderWidth: focused || error ? 1.5 : 1,
          borderColor: edge,
          paddingHorizontal: space.md,
          justifyContent: 'center',
        }}
      >
        <TextInput
          {...input}
          testID={testID}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={palette.textSubtle}
          accessibilityLabel={label}
          accessibilityHint={error ?? hint}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{ fontFamily: fontFamily.medium, fontSize: typeScale.body.fontSize, color: palette.text, paddingVertical: space.sm }}
        />
      </View>
      {error ? (
        <Text variant="caption" style={{ color: palette.danger }} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" tone="muted">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Six boxes, one field. The real input sits invisibly over the boxes so a tap
 * anywhere focuses it, the keyboard is the number pad, and the platform can
 * offer the code from the email or message it arrived in.
 */
export function CodeField({
  value,
  onChangeText,
  length = 6,
  error,
  editable = true,
  autoFocus = true,
  testID,
}: {
  value: string;
  onChangeText: (digits: string) => void;
  length?: number;
  error?: boolean;
  editable?: boolean;
  autoFocus?: boolean;
  testID?: string;
}) {
  const { palette } = useTheme();
  const input = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  const active = Math.min(value.length, length - 1);

  return (
    <Pressable onPress={() => input.current?.focus()} accessible={false} style={{ alignSelf: 'stretch' }}>
      <View style={{ flexDirection: 'row', gap: space.sm, justifyContent: 'space-between' }}>
        {Array.from({ length }, (_, index) => {
          const digit = value[index] ?? '';
          const isActive = focused && editable && index === active;
          return (
            <View
              key={index}
              style={{
                flex: 1,
                maxWidth: 54,
                aspectRatio: 0.86,
                borderRadius: radius.md,
                backgroundColor: palette.surface,
                borderWidth: isActive || error ? 1.5 : 1,
                borderColor: error ? palette.danger : isActive ? palette.accent : palette.edge,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text variant="title">{digit}</Text>
            </View>
          );
        })}
      </View>
      <TextInput
        ref={input}
        testID={testID}
        value={value}
        onChangeText={(text) => onChangeText(text.replace(/\D/g, '').slice(0, length))}
        maxLength={length}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        autoFocus={autoFocus}
        editable={editable}
        caretHidden
        accessibilityLabel={`${length}-digit code`}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0.02, color: 'transparent' }}
      />
    </Pressable>
  );
}
