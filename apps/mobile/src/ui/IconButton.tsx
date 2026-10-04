/**
 * A control that is only an icon: back, bell, cart, heart, share, call.
 *
 * It always has an accessible label — an icon-only control without one is a
 * button a screen-reader user cannot find — and it is always at least 44pt to
 * the touch, however small the glyph is drawn. The boards draw most of these
 * bare, with no plate behind them; `plate` adds one for the few that sit on
 * photography or on a card (call and message on the rider screens).
 */

import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { radius, touchTarget } from '../theme/tokens';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export interface IconButtonProps {
  icon: IconName;
  label: string;
  onPress?: () => void;
  size?: number;
  /** `none` draws the bare glyph; `surface` and `sand` put it on a round plate. */
  plate?: 'none' | 'surface' | 'sand' | 'scrim';
  color?: string;
  /** A count shown in a small bronze badge — the cart, the notification bell. */
  badge?: number;
  /** A dot without a count, for "something new". */
  dot?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function IconButton({
  icon,
  label,
  onPress,
  size = 24,
  plate = 'none',
  color,
  badge,
  dot,
  style,
  testID,
}: IconButtonProps) {
  const { palette } = useTheme();
  const plateColor =
    plate === 'surface' ? palette.surface : plate === 'sand' ? palette.sand : plate === 'scrim' ? palette.scrim : 'transparent';
  const glyph = color ?? (plate === 'scrim' ? '#FFFFFF' : palette.text);

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={badge ? `${label}, ${badge}` : label}
      hitSlop={8}
      style={({ pressed }) => [
        {
          width: touchTarget,
          height: touchTarget,
          borderRadius: radius.pill,
          backgroundColor: plateColor,
          borderWidth: plate === 'surface' ? 1 : 0,
          borderColor: palette.edge,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.6 : 1,
        },
        style,
      ]}
    >
      <Icon name={icon} size={size} color={glyph} />
      {badge ? (
        <View
          style={{
            position: 'absolute',
            top: 4,
            right: 2,
            minWidth: 18,
            height: 18,
            paddingHorizontal: 4,
            borderRadius: radius.pill,
            backgroundColor: palette.accent,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text variant="micro" tone="onAccent">
            {badge > 9 ? '9+' : String(badge)}
          </Text>
        </View>
      ) : dot ? (
        <View
          style={{
            position: 'absolute',
            top: 9,
            right: 10,
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: palette.accent,
            borderWidth: 1.5,
            borderColor: palette.background,
          }}
        />
      ) : null}
    </Pressable>
  );
}
