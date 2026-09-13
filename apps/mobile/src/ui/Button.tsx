/**
 * Buttons, in the four treatments the boards use.
 *
 * - `primary`   — DASH bronze, full width at the foot of a flow: Accept Order,
 *                 Add to Cart, Proceed to Checkout, Confirm Pickup.
 * - `secondary` — warm sand, the quiet alternative beside a primary: Decline,
 *                 Back to Home, View Order Details.
 * - `inverse`   — graphite pill, for a call to action sitting on photography
 *                 or a tinted card, where bronze would disappear into the image:
 *                 Order Now on the Home promotion.
 * - `outline`   — hairline border on the surface, for a low-emphasis action.
 *
 * A press is a small action and gets a small response: the fill deepens and the
 * button gives two percent. Nothing bounces.
 */

import { ActivityIndicator, Pressable, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { controlHeight, radius, space } from '../theme/tokens';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export type ButtonVariant = 'primary' | 'secondary' | 'inverse' | 'outline';

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: 'md' | 'lg';
  /** Pill shape. The boards use it for inverse calls to action on cards. */
  pill?: boolean;
  leadingIcon?: IconName;
  trailingIcon?: IconName;
  disabled?: boolean;
  /** Shows a spinner, keeps the width, and refuses further presses. */
  busy?: boolean;
  /** Read by screen readers when the visible label is not enough on its own. */
  accessibilityHint?: string;
  /**
   * Draw the button without making it one — for a call to action inside a
   * card that is itself the target (the Home campaign). A button inside a
   * button is two targets where there should be one: invalid on the web and
   * confusing to a screen reader, which hears the card and then the button.
   */
  decorative?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'lg',
  pill = false,
  leadingIcon,
  trailingIcon,
  disabled = false,
  busy = false,
  accessibilityHint,
  decorative = false,
  style,
  testID,
}: ButtonProps) {
  const { palette } = useTheme();
  const inert = disabled || busy;

  const fill: Record<ButtonVariant, { bg: string; pressed: string; fg: string; border?: string }> = {
    primary: { bg: palette.accent, pressed: palette.accentPressed, fg: palette.onAccent },
    secondary: { bg: palette.sand, pressed: palette.line, fg: palette.text },
    inverse: { bg: palette.inverse, pressed: palette.inverse, fg: palette.textOnInverse },
    outline: { bg: palette.surface, pressed: palette.sand, fg: palette.text, border: palette.line },
  };
  const tone = fill[variant];

  const content = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      {leadingIcon ? <Icon name={leadingIcon} size={20} color={tone.fg} /> : null}
      <Text variant="bodyStrong" style={{ color: tone.fg }} weight="bold">
        {label}
      </Text>
      {trailingIcon ? <Icon name={trailingIcon} size={18} color={tone.fg} /> : null}
    </View>
  );

  const shape: ViewStyle = {
    minHeight: controlHeight[size],
    paddingHorizontal: pill ? space.xl : space.lg,
    borderRadius: pill ? radius.pill : radius.md,
    borderWidth: tone.border ? 1 : 0,
    borderColor: tone.border,
    alignItems: 'center',
    justifyContent: 'center',
  };

  if (decorative) {
    return (
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[shape, { backgroundColor: tone.bg }, style]}
      >
        {content}
      </View>
    );
  }

  return (
    <Pressable
      testID={testID}
      onPress={inert ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inert, busy }}
      style={({ pressed }) => [
        shape,
        {
          backgroundColor: pressed && !inert ? tone.pressed : tone.bg,
          opacity: disabled ? 0.45 : 1,
          transform: [{ scale: pressed && !inert ? 0.98 : 1 }],
        },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={tone.fg} /> : content}
    </Pressable>
  );
}
