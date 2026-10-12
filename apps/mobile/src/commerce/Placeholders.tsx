/**
 * What stands in for a photograph the catalogue does not have yet.
 *
 * Vendors have no cover or logo field, and product photos are storage keys the
 * API cannot resolve yet, so real shops arrive without pictures. A blank grey
 * box reads as broken, and a stock photo would be a lie about the shop. This is
 * the honest middle: a warm, quiet ground with the symbol of what the shop or
 * shelf sells, in the same frame a photograph will fill, so the layout does
 * not move the day photos arrive.
 */

import { Image } from 'expo-image';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import type { MerchantModel, ProductModel } from '../data/models';
import { useTheme } from '../theme/ThemeProvider';
import { Icon, type IconName } from '../ui/Icon';

const CATEGORY_ICONS: Record<string, IconName> = {
  grocery: 'basket-outline',
  retail: 'shopping-outline',
  restaurant: 'silverware-fork-knife',
  pharmacy: 'pill',
  market: 'storefront-outline',
  declutter: 'sofa-outline',
};

/** The symbol for a vendor category. */
export function categoryIcon(category: string | undefined): IconName {
  return (category && CATEGORY_ICONS[category]) || 'storefront-outline';
}

/** Shop-written shelf names, matched by the words in them. Decoration only. */
const SHELF_WORDS: readonly [RegExp, IconName][] = [
  [/produce|fruit|veg/i, 'food-apple-outline'],
  [/pantry|rice|grain|food|snack/i, 'food-variant'],
  [/drink|beverage|water|juice/i, 'bottle-soda-outline'],
  [/electronic|gadget|phone|tech/i, 'television'],
  [/home|kitchen|living|furniture|bed/i, 'sofa-outline'],
  [/beauty|skin|cosmetic|care/i, 'lipstick'],
  [/fashion|cloth|wear|shoe|bag/i, 'tshirt-crew-outline'],
  [/health|medic|pharm/i, 'pill'],
];

export function shelfIcon(label: string | undefined, fallback: IconName = 'package-variant-closed'): IconName {
  const match = label ? SHELF_WORDS.find(([pattern]) => pattern.test(label)) : undefined;
  return match ? match[1] : fallback;
}

/** A shop's banner: its cover photograph, or the placeholder in the same frame. */
export function CoverArt({ merchant, style }: { merchant: Pick<MerchantModel, 'cover' | 'category' | 'name'>; style: StyleProp<ViewStyle> }) {
  const { palette } = useTheme();
  if (merchant.cover) return <Image source={merchant.cover} style={style as never} contentFit="cover" accessibilityIgnoresInvertColors />;
  return (
    <View
      style={[{ backgroundColor: palette.sand, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }, style]}
      accessibilityLabel={`${merchant.name} has not added photos yet`}
    >
      <Icon name={categoryIcon(merchant.category)} size={44} color={palette.accent} />
    </View>
  );
}

/** A product's photograph, or the placeholder in the same frame. */
export function ProductArt({
  product,
  style,
  fallbackIcon,
}: {
  product: Pick<ProductModel, 'image' | 'name'> & { shelfLabel?: string };
  style: StyleProp<ViewStyle>;
  fallbackIcon?: IconName;
}) {
  const { palette } = useTheme();
  if (product.image) return <Image source={product.image} style={style as never} contentFit="contain" />;
  return (
    <View style={[{ alignItems: 'center', justifyContent: 'center' }, style]} accessibilityLabel={`${product.name}, no photo yet`}>
      <Icon name={shelfIcon(product.shelfLabel, fallbackIcon)} size={34} color={palette.textSubtle} />
    </View>
  );
}
