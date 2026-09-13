/**
 * Search across shops and products.
 *
 * Searches the staging catalogue in this checkpoint. The API already has a
 * search that returns vendors and items together; wiring it is a mapping onto
 * these two result sections, and unified search across Food, Pharmacy, Local
 * Market and Declutter grows from there without redrawing this screen.
 */

import { formatNairaCompact } from '@dash/domain/money';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { SampleDataNote } from '../../src/commerce/Promotions';
import { FEATURED_SHOPS, PRODUCTS } from '../../src/data/staging';
import { useTheme } from '../../src/theme/ThemeProvider';
import { fontFamily, radius, space, typeScale } from '../../src/theme/tokens';
import { AppBar, Avatar, EmptyState, Icon, Screen, SectionHeader, Text } from '../../src/ui';

export default function Search() {
  const router = useRouter();
  const { palette } = useTheme();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const shops = useMemo(() => (q ? FEATURED_SHOPS.filter((s) => `${s.name} ${s.descriptor}`.toLowerCase().includes(q)) : []), [q]);
  const products = useMemo(() => (q ? PRODUCTS.filter((p) => p.name.toLowerCase().includes(q)) : []), [q]);

  return (
    <Screen>
      <AppBar title="Search" />
      <View style={{ paddingHorizontal: space.gutter, gap: space.lg }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            minHeight: 46,
            paddingHorizontal: space.md,
            borderRadius: radius.md,
            backgroundColor: palette.surface,
            borderWidth: 1,
            borderColor: palette.line,
          }}
        >
          <Icon name="magnify" size={20} color={palette.textMuted} />
          <TextInput
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder="Search shops and products"
            placeholderTextColor={palette.textSubtle}
            returnKeyType="search"
            accessibilityLabel="Search shops and products"
            style={{ flex: 1, fontFamily: fontFamily.medium, fontSize: typeScale.body.fontSize, color: palette.text }}
          />
        </View>

        {!q ? (
          <Text variant="caption" tone="muted">
            Try “iPhone” or “TechWorld”.
          </Text>
        ) : shops.length === 0 && products.length === 0 ? (
          <EmptyState icon="magnify" title="No results" body={`Nothing matched “${query.trim()}”. Check the spelling or try something broader.`} />
        ) : (
          <>
            {shops.length > 0 ? (
              <View>
                <SectionHeader title="Shops" />
                {shops.map((shop) => (
                  <Pressable
                    key={shop.slug}
                    onPress={() => router.push(`/store/${shop.slug}`)}
                    accessibilityRole="button"
                    accessibilityLabel={`${shop.name}, ${shop.descriptor}`}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm }}
                  >
                    <Avatar source={shop.logo} name={shop.name} size={44} />
                    <View style={{ flex: 1 }}>
                      <Text variant="label" weight="bold">
                        {shop.name}
                      </Text>
                      <Text variant="caption" tone="muted">
                        {shop.descriptor}
                      </Text>
                    </View>
                    <Icon name="chevron-right" size={22} color={palette.textSubtle} />
                  </Pressable>
                ))}
              </View>
            ) : null}
            {products.length > 0 ? (
              <View>
                <SectionHeader title="Products" />
                {products.map((product) => (
                  <Pressable
                    key={product.id}
                    onPress={() => router.push(`/product/${product.id}`)}
                    accessibilityRole="button"
                    accessibilityLabel={`${product.name}, ${formatNairaCompact(product.price)}`}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm }}
                  >
                    <View style={{ width: 52, height: 52, borderRadius: radius.md, backgroundColor: palette.surfaceMuted, overflow: 'hidden' }}>
                      <Image source={product.image} style={{ width: '100%', height: '100%' }} contentFit="contain" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text variant="label" weight="bold">
                        {product.name}
                      </Text>
                      <Text variant="caption" tone="muted">
                        {formatNairaCompact(product.price)}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </>
        )}
        <SampleDataNote />
      </View>
    </Screen>
  );
}
