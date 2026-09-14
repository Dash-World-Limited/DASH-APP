import { Image } from 'expo-image';

import type { ServiceId } from './CategoryArtwork';

const CATEGORY_PHOTOS = {
  food: require('../../../assets/v2/categories/food.png'),
  shops: require('../../../assets/v2/categories/shops.png'),
  pharmacy: require('../../../assets/v2/categories/pharmacy.png'),
  'local-market': require('../../../assets/v2/categories/local-market.png'),
  declutter: require('../../../assets/v2/categories/declutter.png'),
  logistics: require('../../../assets/v2/categories/logistics.png'),
} as const;

export function CategoryPhoto({
  id,
  size,
  accessibilityLabel,
}: {
  id: ServiceId;
  size: number;
  accessibilityLabel?: string;
}) {
  return (
    <Image
      source={CATEGORY_PHOTOS[id]}
      style={{ width: size, height: size }}
      contentFit="contain"
      accessibilityLabel={accessibilityLabel}
    />
  );
}
