/**
 * Shops — the Customer board, screen 2.
 *
 * Search across shops, the shop categories as round doors, a rail of shops,
 * and the full list below it. The frame is DASH's; the merchants supply the
 * photographs.
 *
 * Live when the build has an API: the Shops merchants come from
 * `GET /v1/vendors?service=shops`, and the category doors are the vendor
 * categories those shops actually belong to, so the structure is real and can
 * never collapse to "All" while there are shops to show. The API has no
 * "featured" or "popular" signal, so the rail is honestly "Top rated" (by the
 * shops' real ratings) and the list is "All shops"; neither is invented.
 * Without an API the board's staging fixtures are drawn, and the screen says so.
 */

import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { MerchantCard, WideMerchantCard } from '../../../../src/commerce/MerchantCards';
import { categoryIcon } from '../../../../src/commerce/Placeholders';
import { CategoryBubble, SampleDataNote } from '../../../../src/commerce/Promotions';
import { useShops } from '../../../../src/data/useCatalog';
import { useCart } from '../../../../src/features/CartProvider';
import { space } from '../../../../src/theme/tokens';
import { AppBar, EmptyState, ErrorState, IconButton, Screen, SearchField, SectionHeader, Skeleton } from '../../../../src/ui';

export default function ShopsLanding() {
  const router = useRouter();
  const { count } = useCart();
  const [category, setCategory] = useState('all');
  const shops = useShops();
  const live = shops.live;

  const matches = useMemo(() => {
    const data = shops.data;
    if (!data) return { rail: [], list: [] };
    if (!live || category === 'all') return { rail: data.rail, list: data.list };
    const inCategory = (m: { category?: string }) => m.category === category;
    return { rail: data.rail.filter(inCategory), list: data.list.filter(inCategory) };
  }, [shops.data, live, category]);

  const open = (slug: string): void => router.push(`/store/${slug}`);

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

        {shops.status === 'loading' ? (
          <View style={{ gap: space.lg }} accessibilityLabel="Loading shops">
            <View style={{ flexDirection: 'row', gap: space.md }}>
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} style={{ width: 58, height: 58, borderRadius: 29 }} />
              ))}
            </View>
            <View style={{ flexDirection: 'row', gap: space.md }}>
              <Skeleton style={{ width: 168, height: 220, borderRadius: 16 }} />
              <Skeleton style={{ width: 168, height: 220, borderRadius: 16 }} />
            </View>
          </View>
        ) : shops.status === 'error' ? (
          <ErrorState title="Shops could not load" message={shops.error ?? 'Please try again.'} onRetry={shops.retry} />
        ) : shops.data && shops.data.rail.length === 0 && shops.data.list.length === 0 ? (
          <EmptyState icon="storefront-outline" title="No shops yet" body="Shops will appear here as they open on DASH." />
        ) : shops.data ? (
          <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.xs }} style={{ marginHorizontal: -space.xs }}>
              {shops.data.categories.map((c) => (
                <CategoryBubble
                  key={c.id}
                  label={c.label}
                  image={c.image}
                  icon={c.id === 'all' ? undefined : categoryIcon(c.id)}
                  selected={category === c.id}
                  onPress={() => setCategory(c.id)}
                />
              ))}
            </ScrollView>

            <View>
              <SectionHeader title={live ? 'Top rated' : 'Featured Shops'} action="See All" onAction={() => router.push('/search')} />
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: space.md, paddingHorizontal: space.gutter, paddingBottom: space.xs }}
                style={{ marginHorizontal: -space.gutter }}
              >
                {matches.rail.map((merchant) => (
                  <MerchantCard key={merchant.slug} merchant={merchant} onPress={() => open(merchant.slug)} />
                ))}
              </ScrollView>
            </View>

            <View style={{ gap: space.lg }}>
              <SectionHeader title={live ? 'All shops' : 'Popular Near You'} />
              {matches.list.map((merchant) => (
                <WideMerchantCard key={merchant.slug} merchant={merchant} onPress={() => open(merchant.slug)} />
              ))}
            </View>
          </>
        ) : null}

        {live ? null : <SampleDataNote />}
      </View>
    </Screen>
  );
}
