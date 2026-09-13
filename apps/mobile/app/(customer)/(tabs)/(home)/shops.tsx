/**
 * Shops — the Customer board, screen 2.
 *
 * Search across shops, the shop categories as round doors, a rail of featured
 * shops, and a popular shop nearby. The frame is DASH's; the merchants supply
 * the photographs.
 *
 * STAGING DATA. The API can list Shops merchants today (`/v1/vendors?service=
 * shops`), but serves no cover or logo photographs, no shop sub-categories and
 * no "featured" or "popular" signal — so this screen draws from fixtures until
 * those exist, and says so at its foot. Featured must be an editorial choice
 * and popular must come from real order counts; neither is invented here.
 */

import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { MerchantCard, WideMerchantCard } from '../../../../src/commerce/MerchantCards';
import { CategoryBubble, SampleDataNote } from '../../../../src/commerce/Promotions';
import { FEATURED_SHOPS, POPULAR_NEAR_YOU, SHOP_CATEGORIES } from '../../../../src/data/staging';
import { useCart } from '../../../../src/features/CartProvider';
import { space } from '../../../../src/theme/tokens';
import { AppBar, IconButton, Screen, SearchField, SectionHeader } from '../../../../src/ui';

export default function ShopsLanding() {
  const router = useRouter();
  const { count } = useCart();
  const [category, setCategory] = useState('all');

  return (
    <Screen testID="shops-landing">
      <AppBar
        title="Shops"
        right={<IconButton icon="cart-outline" label="Cart" badge={count} onPress={() => router.push('/cart')} />}
      />
      <View style={{ paddingHorizontal: space.gutter, gap: space.xl }}>
        <SearchField
          placeholder="Search shops, products, brands..."
          editable={false}
          onPress={() => router.push('/search')}
          onFilter={() => router.push('/search')}
        />

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.xs }} style={{ marginHorizontal: -space.xs }}>
          {SHOP_CATEGORIES.map((c) => (
            <CategoryBubble key={c.id} label={c.label} image={c.image} selected={category === c.id} onPress={() => setCategory(c.id)} />
          ))}
        </ScrollView>

        <View>
          <SectionHeader title="Featured Shops" action="See All" onAction={() => router.push('/search')} />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: space.md, paddingHorizontal: space.gutter, paddingBottom: space.xs }}
            style={{ marginHorizontal: -space.gutter }}
          >
            {FEATURED_SHOPS.map((merchant) => (
              <MerchantCard key={merchant.slug} merchant={merchant} onPress={() => router.push(`/store/${merchant.slug}`)} />
            ))}
          </ScrollView>
        </View>

        <View>
          <SectionHeader title="Popular Near You" action="See All" onAction={() => router.push('/search')} />
          {POPULAR_NEAR_YOU.map((merchant) => (
            <WideMerchantCard key={merchant.slug} merchant={merchant} onPress={() => router.push(`/store/${merchant.slug}`)} />
          ))}
        </View>

        <SampleDataNote />
      </View>
    </Screen>
  );
}
