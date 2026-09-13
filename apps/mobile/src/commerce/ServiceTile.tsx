/**
 * One of the six service doors on Home.
 *
 * As on the Customer board: a light tile, the service's illustration on top,
 * the name in bold and a single line beneath it. Six identical frames in a
 * three-by-two grid — no door is larger, tinted or badged, because DASH is six
 * services and must never read as one of them with extras.
 */

import { Image } from 'expo-image';
import { Pressable, View } from 'react-native';

import type { ServiceTileModel } from '../data/services';
import { useTheme } from '../theme/ThemeProvider';
import { radius, space } from '../theme/tokens';
import { Text } from '../ui/Text';

export function ServiceTile({ tile, onPress }: { tile: ServiceTileModel; onPress: () => void }) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${tile.label}, ${tile.sublabel}`}
      testID={`service-${tile.id}`}
      style={({ pressed }) => ({
        flex: 1,
        alignItems: 'center',
        // Proportions from the board: a tile is about 1.3x as tall as it is
        // wide, most of it illustration.
        paddingTop: space.lg,
        paddingBottom: space.md + 2,
        paddingHorizontal: space.xs,
        borderRadius: radius.lg,
        backgroundColor: palette.surface,
        borderWidth: 1,
        borderColor: palette.line,
        transform: [{ scale: pressed ? 0.97 : 1 }],
      })}
    >
      <Image source={tile.art} style={{ width: 88, height: 72 }} contentFit="contain" />
      <View style={{ alignItems: 'center', marginTop: space.md }}>
        <Text variant="label" weight="bold" numberOfLines={1}>
          {tile.label}
        </Text>
        <Text variant="micro" tone="muted" weight="medium" numberOfLines={1}>
          {tile.sublabel}
        </Text>
      </View>
    </Pressable>
  );
}
