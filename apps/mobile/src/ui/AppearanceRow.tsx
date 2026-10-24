/**
 * Appearance — Light | Dark, as a row in Profile & Settings on both boards.
 *
 * Changes the theme immediately and remembers it. Light is the default and is
 * what the approved boards show; Dark is supported through the same tokens.
 */

import { View } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { space } from '../theme/tokens';
import { SegmentedControl } from './Controls';
import { Icon } from './Icon';
import { Text } from './Text';

const OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const;

export function AppearanceRow() {
  const { palette, scheme, setAppearance } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 52, gap: space.md }}>
      <Icon name="palette-outline" size={22} color={palette.text} />
      <Text variant="body" style={{ flex: 1 }}>
        Appearance
      </Text>
      <SegmentedControl
        options={OPTIONS}
        value={scheme}
        onChange={setAppearance}
        accessibilityLabel="Appearance"
        style={{ width: 148 }}
      />
    </View>
  );
}
