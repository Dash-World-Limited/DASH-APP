/**
 * Merchant presentation, standardised by DASH.
 *
 * A merchant supplies photographs, a name, what they sell and their hours;
 * DASH decides the frame. That is why these are two fixed components rather
 * than something a shop can style — every storefront reads the same way, and
 * a customer learns the layout once.
 *
 * - `MerchantCard` — the portrait card in a horizontal rail (Featured Shops).
 * - `WideMerchantCard` — the full-width banner with the large logo that
 *   overlaps it (Popular Near You).
 */

import { Image } from 'expo-image';
import { Pressable, View } from 'react-native';

import type { MerchantModel } from '../data/models';
import { formatCount, formatEta, formatRating } from '../lib/format';
import { useTheme } from '../theme/ThemeProvider';
import { elevation, radius, space } from '../theme/tokens';
import { Avatar } from '../ui/Display';
import { Icon } from '../ui/Icon';
import { Text } from '../ui/Text';

export function RatingLine({
  rating,
  eta,
  showCount = false,
}: {
  rating: MerchantModel['rating'];
  eta: MerchantModel['eta'];
  showCount?: boolean;
}) {
  const { palette } = useTheme();
  if (!rating && !eta) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      {rating ? (
        <>
          <Icon name="star" size={15} color={palette.rating} />
          <Text variant="caption" weight="semibold">
            {formatRating(rating.average)}
          </Text>
          {showCount ? (
            <Text variant="caption" tone="muted">
              ({formatCount(rating.count)})
            </Text>
          ) : null}
        </>
      ) : null}
      {rating && eta ? (
        <Text variant="caption" tone="subtle">
          {' '}•{' '}
        </Text>
      ) : null}
      {eta ? (
        <Text variant="caption" tone="muted">
          {formatEta(eta)}
        </Text>
      ) : null}
    </View>
  );
}

export function MerchantCard({ merchant, onPress, width = 168 }: { merchant: MerchantModel; onPress: () => void; width?: number }) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${merchant.name}, ${merchant.descriptor}`}
      style={({ pressed }) => ({
        width,
        borderRadius: radius.lg,
        backgroundColor: palette.surface,
        borderWidth: 1,
        borderColor: palette.edge,
        overflow: 'hidden',
        ...elevation.card,
        transform: [{ scale: pressed ? 0.98 : 1 }],
      })}
    >
      <Image source={merchant.cover} style={{ width: '100%', height: 138 }} contentFit="cover" />
      <View style={{ position: 'absolute', top: 138 - 18, left: space.md }}>
        <Avatar source={merchant.logo} name={merchant.name} size={34} ring />
      </View>
      <View style={{ padding: space.md, paddingTop: space.xl, gap: 2 }}>
        <Text variant="label" weight="bold" numberOfLines={1}>
          {merchant.name}
        </Text>
        <Text variant="caption" tone="muted" numberOfLines={1}>
          {merchant.descriptor}
        </Text>
        <View style={{ marginTop: space.xs }}>
          <RatingLine rating={merchant.rating} eta={merchant.eta} />
        </View>
      </View>
    </Pressable>
  );
}

export function WideMerchantCard({ merchant, onPress }: { merchant: MerchantModel; onPress: () => void }) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${merchant.name}, ${merchant.descriptor}`}
      style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.99 : 1 }] })}
    >
      <Image
        source={merchant.cover}
        style={{ width: '100%', height: 112, borderRadius: radius.lg, backgroundColor: palette.sand }}
        contentFit="cover"
      />
      {/* Only the logo overlaps the banner; the words sit below it. */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md, marginTop: -32, paddingLeft: space.md }}>
        <Avatar source={merchant.logo} name={merchant.name} size={64} ring />
        <View style={{ flex: 1, marginTop: 36, gap: 1 }}>
          <Text variant="label" weight="bold" numberOfLines={1}>
            {merchant.name}
          </Text>
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {merchant.descriptor}
          </Text>
          <View style={{ marginTop: space.xs }}>
            <RatingLine rating={merchant.rating} eta={merchant.eta} />
          </View>
        </View>
      </View>
    </Pressable>
  );
}
