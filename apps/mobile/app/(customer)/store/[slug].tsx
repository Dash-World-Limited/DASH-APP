/**
 * Shop Storefront — the Customer board, screen 3.
 *
 * The standard DASH storefront. The merchant supplies the photographs, the
 * name, what they sell, their hours and their products; DASH supplies this
 * frame, identical for every shop. A hero photograph under the status bar, the
 * shop's logo overlapping it, the name and rating, the shelves, and a grid of
 * photographed products — never a text list of product names.
 *
 * One addition to the board: once something is in the cart, a "View cart" bar
 * appears at the foot. The board shows the empty state; without the bar a
 * customer who tapped a plus would have no way to reach what they added.
 *
 * Live when the build has an API: `GET /v1/vendors/:slug` gives the shop, its
 * own shelves (in the shop's order) and its products; shops have no photos in
 * the API yet, so the hero and product tiles draw the designed placeholders
 * (commerce/Placeholders). Without an API the staging fixtures are drawn and
 * the foot of the screen says so.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useMemo, useState } from 'react';
import { ScrollView, Share, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RatingLine } from '../../../src/commerce/MerchantCards';
import { CoverArt } from '../../../src/commerce/Placeholders';
import { ProductCard } from '../../../src/commerce/ProductCard';
import { SampleDataNote } from '../../../src/commerce/Promotions';
import { useStorefront } from '../../../src/data/useCatalog';
import { useCart } from '../../../src/features/CartProvider';
import { quickAddPlan } from '../../../src/features/quickAdd';
import { useAddToCart } from '../../../src/features/useAddToCart';
import { useSaved } from '../../../src/features/saved';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { space } from '../../../src/theme/tokens';
import { ActionFooter, Avatar, Button, Chip, EmptyState, ErrorState, IconButton, Skeleton, Text } from '../../../src/ui';

const HERO_HEIGHT = 240;

export default function Storefront() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { palette } = useTheme();
  const { count } = useCart();
  const addToCart = useAddToCart();
  const [shelf, setShelf] = useState<string>('all');
  const { isSaved, toggle } = useSaved();

  const store = useStorefront(slug);
  const products = useMemo(
    () => (store.data?.products ?? []).filter((p) => shelf === 'all' || p.shelf === shelf),
    [store.data, shelf],
  );

  if (store.status !== 'ready' || !store.data) {
    return (
      <View style={{ flex: 1, paddingTop: insets.top, backgroundColor: palette.background }} testID="storefront-state">
        <IconButton icon="chevron-left" size={30} label="Back" onPress={() => router.back()} />
        {store.status === 'loading' ? (
          <View style={{ paddingHorizontal: space.gutter, gap: space.lg }} accessibilityLabel="Loading shop">
            <Skeleton style={{ height: 180, borderRadius: 16 }} />
            <Skeleton style={{ width: 200, height: 24 }} />
            <Skeleton style={{ width: 140, height: 16 }} />
            <View style={{ flexDirection: 'row', gap: space.md }}>
              <Skeleton style={{ flex: 1, height: 170, borderRadius: 16 }} />
              <Skeleton style={{ flex: 1, height: 170, borderRadius: 16 }} />
            </View>
          </View>
        ) : store.notFound ? (
          <EmptyState icon="storefront-outline" title="Shop not found" body="This shop is not available right now." action="Back to Shops" onAction={() => router.back()} />
        ) : (
          <ErrorState title="This shop could not load" message={store.error ?? 'Please try again.'} onRetry={store.retry} />
        )}
      </View>
    );
  }

  const { merchant, shelves, hero } = store.data;
  // A product with a choice to make opens instead of adding — see quickAddPlan.
  const add = (product: (typeof products)[number]): void => {
    const plan = quickAddPlan(product);
    if (plan.kind === 'choose') openProduct(product.id);
    else addToCart({ merchantSlug: merchant.slug, productId: product.id, quantity: 1, options: plan.options });
  };

  function openProduct(id: string): void {
    router.push({ pathname: '/product/[id]', params: { id, store: merchant.slug } });
  }

  return (
    <View style={{ flex: 1, backgroundColor: palette.background }} testID="storefront">
      <StatusBar style={hero ? 'light' : palette.statusBar} />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: space.xxl }}>
        <View style={{ height: HERO_HEIGHT + insets.top }}>
          <CoverArt merchant={{ ...merchant, cover: hero }} style={{ position: 'absolute', inset: 0 }} />
          <View
            style={{
              marginTop: insets.top,
              flexDirection: 'row',
              justifyContent: 'space-between',
              paddingHorizontal: space.xs,
            }}
          >
            <IconButton icon="chevron-left" size={30} label="Back" plate="scrim" onPress={() => router.back()} />
            <IconButton
              icon="export-variant"
              label={`Share ${merchant.name}`}
              plate="scrim"
              onPress={() => void Share.share({ message: `${merchant.name} on DASH — www.dashworldng.com` }).catch(() => undefined)}
            />
          </View>
        </View>

        <View style={{ paddingHorizontal: space.gutter }}>
          <View style={{ marginTop: -34 }}>
            <Avatar source={merchant.logo} name={merchant.name} size={68} ring />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginTop: space.sm }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="title" accessibilityRole="header">
                {merchant.name}
              </Text>
              <Text variant="caption" tone="muted">
                {merchant.descriptor}
              </Text>
            </View>
            <IconButton
              icon={isSaved(`shop:${merchant.slug}`) ? 'heart' : 'heart-outline'}
              color={isSaved(`shop:${merchant.slug}`) ? palette.danger : palette.text}
              label={isSaved(`shop:${merchant.slug}`) ? `Remove ${merchant.name} from saved shops` : `Save ${merchant.name}`}
              onPress={() => toggle(`shop:${merchant.slug}`)}
            />
          </View>
          <View style={{ marginTop: space.sm }}>
            <RatingLine rating={merchant.rating} eta={merchant.eta} showCount />
          </View>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: space.sm, paddingVertical: space.lg }}
          >
            {shelves.map((s) => (
              <Chip key={s.id} label={s.label} selected={shelf === s.id} onPress={() => setShelf(s.id)} />
            ))}
          </ScrollView>

          {products.length === 0 ? (
            <EmptyState icon="package-variant-closed" title="Nothing on this shelf" body="Try another shelf, or come back later — shops add products all the time." />
          ) : (
            <View style={{ gap: space.xl }}>
              {pairs(products).map((row) => (
                <View key={row.map((p) => p.id).join()} style={{ flexDirection: 'row', gap: space.md }}>
                  {row.map((product) => (
                    <ProductCard
                      key={product.id}
                      product={product}
                      onPress={() => openProduct(product.id)}
                      onAdd={() => add(product)}
                      needsChoice={quickAddPlan(product).kind === 'choose'}
                    />
                  ))}
                  {row.length === 1 ? <View style={{ flex: 1 }} /> : null}
                </View>
              ))}
            </View>
          )}
          {store.live ? null : <SampleDataNote />}
        </View>
      </ScrollView>
      {count > 0 ? (
        <ActionFooter>
          <Button label={`View Cart (${count})`} leadingIcon="cart-outline" onPress={() => router.push('/cart')} />
        </ActionFooter>
      ) : null}
    </View>
  );
}

function pairs<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 2) out.push(items.slice(i, i + 2));
  return out;
}
