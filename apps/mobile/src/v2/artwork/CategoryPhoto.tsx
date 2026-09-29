import { Image } from 'expo-image';

import declutterPhoto from '../../../assets/v2/categories/declutter.png';
import foodPhoto from '../../../assets/v2/categories/food.png';
import localMarketPhoto from '../../../assets/v2/categories/local-market.png';
import logisticsPhoto from '../../../assets/v2/categories/logistics.png';
import pharmacyPhoto from '../../../assets/v2/categories/pharmacy.png';
import shopsPhoto from '../../../assets/v2/categories/shops.png';
import type { ServiceId } from './CategoryArtwork';

// Imported rather than `require`d: src/types/assets.d.ts types static image
// imports precisely so screens need no CommonJS, which is what keeps the lint
// rule against it meaningful everywhere else.
const CATEGORY_PHOTOS = {
  food: foodPhoto,
  shops: shopsPhoto,
  pharmacy: pharmacyPhoto,
  'local-market': localMarketPhoto,
  declutter: declutterPhoto,
  logistics: logisticsPhoto,
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
