/**
 * Profile and settings lists, shared by the customer Account and the rider
 * Profile: a titled group of rows in one card, divided by hairlines, rather
 * than a card per row. Every row either goes somewhere or is not drawn as
 * pressable — no chevron on a row that does nothing.
 */

import { Children, Fragment, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { useTheme } from '../../theme/ThemeProvider';
import { radius, space } from '../../theme/tokens';
import { Icon, type IconName } from '../../ui/Icon';
import { Text } from '../../ui/Text';

const ICON_COLUMN = 28;

export function SettingsSection({ title, children }: { title?: string; children: ReactNode }) {
  const { palette } = useTheme();
  const rows = Children.toArray(children).filter(Boolean);
  if (rows.length === 0) return null;
  return (
    <View style={{ gap: space.sm }}>
      {title ? (
        <Text variant="micro" tone="muted" weight="bold" accessibilityRole="header" style={{ paddingHorizontal: space.xs, letterSpacing: 0.6 }}>
          {title.toUpperCase()}
        </Text>
      ) : null}
      <View style={{ borderRadius: radius.lg, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, overflow: 'hidden' }}>
        {rows.map((row, index) => (
          <Fragment key={index}>
            {index > 0 ? <View style={{ height: 1, backgroundColor: palette.line, marginLeft: space.lg + ICON_COLUMN + space.md }} /> : null}
            {row}
          </Fragment>
        ))}
      </View>
    </View>
  );
}

export function SettingsItem({
  icon,
  label,
  detail,
  onPress,
  tone = 'default',
  testID,
}: {
  icon: IconName;
  label: string;
  /** A second line: what is inside, or the current value. */
  detail?: string;
  onPress?: () => void;
  tone?: 'default' | 'danger';
  testID?: string;
}) {
  const { palette } = useTheme();
  const danger = tone === 'danger';
  const row = (pressed: boolean) => (
    <View
      style={{
        minHeight: 58,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        paddingHorizontal: space.lg,
        paddingVertical: space.sm,
        backgroundColor: pressed ? palette.sand : 'transparent',
      }}
    >
      <View style={{ width: ICON_COLUMN, alignItems: 'center' }}>
        <Icon name={icon} size={22} color={danger ? palette.danger : palette.accent} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body" weight="semibold" style={{ color: danger ? palette.danger : palette.text }}>{label}</Text>
        {detail ? <Text variant="caption" tone="muted">{detail}</Text> : null}
      </View>
      {onPress && !danger ? <Icon name="chevron-right" size={22} color={palette.textSubtle} /> : null}
    </View>
  );
  if (!onPress) return row(false);
  return (
    <Pressable testID={testID} onPress={onPress} accessibilityRole="button" accessibilityLabel={detail ? `${label}. ${detail}` : label}>
      {({ pressed }) => row(pressed)}
    </Pressable>
  );
}
