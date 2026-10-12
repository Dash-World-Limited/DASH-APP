/**
 * Selection and input controls.
 *
 * Two kinds of "selected" appear on the boards and they mean different things,
 * so they are two components rather than one with a flag:
 *
 * - `Chip` filters content. Selected is a graphite fill — "All" above a shop's
 *   products, "256GB" on a product. Customer-facing, quiet.
 * - `SegmentedControl` switches a view. Selected is DASH bronze — Today / This
 *   Week on earnings, Light / Dark under Appearance.
 */

import { useEffect, useRef } from 'react';
import { Animated, Pressable, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { elevation, fontFamily, motion, radius, space, touchTarget, typeScale } from '../theme/tokens';
import { Icon } from './Icon';
import { IconButton } from './IconButton';
import { Text } from './Text';

export function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      hitSlop={{ top: 6, bottom: 6 }}
      style={({ pressed }) => ({
        minHeight: 36,
        paddingHorizontal: space.lg,
        borderRadius: radius.pill,
        justifyContent: 'center',
        backgroundColor: selected ? palette.inverse : palette.surface,
        borderWidth: selected ? 0 : 1,
        borderColor: palette.edge,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Text variant="label" style={{ color: selected ? palette.textOnInverse : palette.text }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
  style,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { palette } = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      style={[{ flexDirection: 'row', backgroundColor: palette.sand, borderRadius: radius.md, padding: 3 }, style]}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            accessibilityLabel={option.label}
            style={{
              flex: 1,
              minHeight: 36,
              borderRadius: radius.sm + 2,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: selected ? palette.accent : 'transparent',
            }}
          >
            <Text variant="label" style={{ color: selected ? palette.onAccent : palette.textMuted }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The search field. The filter control sits inside its right edge on both the
 * Home and Shops boards, so it is part of the field, not a sibling.
 */
export function SearchField({
  placeholder,
  value,
  onChangeText,
  onFilter,
  onSubmit,
  editable = true,
  onPress,
}: {
  placeholder: string;
  value?: string;
  onChangeText?: (text: string) => void;
  onFilter?: () => void;
  onSubmit?: () => void;
  /** A read-only field that opens the search screen when tapped. */
  editable?: boolean;
  onPress?: () => void;
}) {
  const { palette } = useTheme();
  const input = (
    <>
      <Icon name="magnify" size={20} color={palette.textMuted} />
      {editable ? (
        <TextInput
          value={value}
          onChangeText={onChangeText}
          onSubmitEditing={onSubmit}
          placeholder={placeholder}
          placeholderTextColor={palette.textSubtle}
          returnKeyType="search"
          accessibilityLabel={placeholder}
          style={{
            flex: 1,
            fontFamily: fontFamily.medium,
            fontSize: typeScale.caption.fontSize + 1,
            color: palette.text,
            paddingVertical: space.sm,
          }}
        />
      ) : (
        <Text
          variant="caption"
          numberOfLines={1}
          style={{ flex: 1, color: palette.textSubtle, fontSize: typeScale.caption.fontSize + 1 }}
        >
          {placeholder}
        </Text>
      )}
    </>
  );
  const inner = { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingLeft: space.md, minHeight: 46 } as const;
  // The field and the filter are siblings, never one inside the other: a
  // pressable wrapping a button is two nested targets.
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingRight: onFilter ? 0 : space.md,
        borderRadius: radius.md,
        backgroundColor: palette.surface,
        borderWidth: 1,
        borderColor: palette.edge,
      }}
    >
      {editable || !onPress ? (
        <View style={inner}>{input}</View>
      ) : (
        <Pressable onPress={onPress} accessibilityRole="search" accessibilityLabel={placeholder} style={inner}>
          {input}
        </Pressable>
      )}
      {onFilter ? <IconButton icon="tune-variant" label="Filters" size={20} onPress={onFilter} /> : null}
    </View>
  );
}

/**
 * The boards' toggle: a wide bronze pill with a white knob — larger and
 * warmer than the platform switch, and the Online control a rider reaches for
 * with a thumb while holding handlebars. Announced as a switch with its state.
 */
export function Toggle({
  value,
  onValueChange,
  label,
  disabled = false,
}: {
  value: boolean;
  onValueChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  const { palette } = useTheme();
  const position = useRef(new Animated.Value(value ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(position, { toValue: value ? 1 : 0, duration: motion.base, useNativeDriver: false }).start();
  }, [value, position]);

  const WIDTH = 54;
  const KNOB = 26;
  return (
    <Pressable
      onPress={() => !disabled && onValueChange(!value)}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      hitSlop={10}
      style={{ opacity: disabled ? 0.5 : 1 }}
    >
      <Animated.View
        style={{
          width: WIDTH,
          height: 32,
          borderRadius: radius.pill,
          padding: 3,
          backgroundColor: position.interpolate({ inputRange: [0, 1], outputRange: [palette.line, palette.accent] }),
        }}
      >
        <Animated.View
          style={{
            width: KNOB,
            height: KNOB,
            borderRadius: KNOB / 2,
            backgroundColor: '#FFFFFF',
            ...elevation.knob,
            transform: [{ translateX: position.interpolate({ inputRange: [0, 1], outputRange: [0, WIDTH - KNOB - 6] }) }],
          }}
        />
      </Animated.View>
    </Pressable>
  );
}

/**
 * − 1 + in a bordered pill, as on Product Detail and in the cart. The value is
 * announced, and each button says what it will do to it.
 */
export function QuantityStepper({
  value,
  onChange,
  min = 1,
  max = 20,
  itemName,
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  itemName: string;
}) {
  const { palette } = useTheme();
  const step = (delta: number): void => onChange(Math.min(max, Math.max(min, value + delta)));
  return (
    <View
      accessibilityRole="adjustable"
      accessibilityLabel={`${itemName} quantity`}
      accessibilityValue={{ min, max, now: value, text: String(value) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) => step(event.nativeEvent.actionName === 'increment' ? 1 : -1)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: palette.edge,
        borderRadius: radius.md,
        backgroundColor: palette.surface,
        minHeight: touchTarget,
      }}
    >
      <IconButton icon="minus" size={18} label={`Remove one ${itemName}`} onPress={() => step(-1)} />
      <Text variant="bodyStrong" style={{ minWidth: 20 }} align="center">
        {value}
      </Text>
      <IconButton icon="plus" size={18} label={`Add one ${itemName}`} onPress={() => step(1)} />
    </View>
  );
}
