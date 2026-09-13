/**
 * A product in a storefront grid: photograph first, then name, then price,
 * with the add control on the photograph's corner — as on the Shop Storefront
 * board.
 *
 * Two targets, side by side rather than one inside the other. The photograph
 * and words open the product; the bronze plus adds it directly. Nesting the
 * plus inside the card would make a button inside a button — invalid on the
 * web, and on iOS the card would swallow the plus from VoiceOver. As siblings,
 * each is its own focusable control with its own label on every platform.
 */

import { formatNairaCompact } from '@dash/domain/money';
import { Image } from 'expo-image';
import { Pressable, View } from 'react-native';

import type { ProductModel } from '../data/models';
import { useTheme } from '../theme/ThemeProvider';
import { radius, space } from '../theme/tokens';
import { Icon } from '../ui/Icon';
import { Text } from '../ui/Text';

/** The photograph's aspect, so the plus can sit on its corner without measuring. */
const PHOTO_ASPECT = 1.08;

export function ProductCard({
  product,
  onPress,
  onAdd,
  needsChoice = false,
}: {
  product: ProductModel;
  onPress: () => void;
  onAdd: () => void;
  /** The plus opens the product to choose options rather than adding. */
  needsChoice?: boolean;
}) {
  const { palette } = useTheme();
  const price = formatNairaCompact(product.price);
  return (
    <View style={{ flex: 1 }} testID={`product-${product.id}`}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${product.name}, ${price}`}
        style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.98 : 1 }] })}
      >
        <View style={{ borderRadius: radius.lg, backgroundColor: palette.surfaceMuted, overflow: 'hidden' }}>
          <Image source={product.image} style={{ width: '100%', aspectRatio: PHOTO_ASPECT }} contentFit="contain" />
        </View>
        <View style={{ paddingTop: space.md, paddingHorizontal: 2, paddingRight: 40, gap: 2 }}>
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {product.name}
          </Text>
          <Text variant="bodyStrong" weight="bold">
            {price}
          </Text>
        </View>
      </Pressable>
      {/* Anchored to the bottom-right of the photograph: the photo is full
          width at a fixed aspect, so its height is width / aspect. */}
      <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, top: 0, aspectRatio: PHOTO_ASPECT }}>
        <Pressable
          onPress={onAdd}
          accessibilityRole="button"
          accessibilityLabel={needsChoice ? `Choose options for ${product.name}` : `Add ${product.name} to cart`}
          hitSlop={10}
          testID={`add-${product.id}`}
          style={({ pressed }) => ({
            position: 'absolute',
            right: space.sm,
            bottom: -12,
            width: 32,
            height: 32,
            borderRadius: 16,
            backgroundColor: pressed ? palette.accentPressed : palette.accent,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 2,
            borderColor: palette.background,
          })}
        >
          <Icon name="plus" size={18} color={palette.onAccent} />
        </Pressable>
      </View>
    </View>
  );
}
