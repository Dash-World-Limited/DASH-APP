/**
 * Search across shops and products.
 *
 * Live when the build has an API: `GET /v1/search` returns shops and products
 * together, and this screen draws them as two sections. It waits for a pause in
 * typing and for two characters (the API's own minimum) before asking. A
 * product opens inside its own shop's storefront data, so its options and
 * availability are the shop's. Without an API it searches the staging
 * catalogue, and says so.
 */

import { formatNairaCompact } from '@dash/domain/money';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { ProductArt } from '../../src/commerce/Placeholders';
import { SampleDataNote } from '../../src/commerce/Promotions';
import { SEARCH_MIN_LENGTH } from '../../src/data/catalog';
import { useCatalogueSearch } from '../../src/data/useCatalog';
import { useTheme } from '../../src/theme/ThemeProvider';
import { fontFamily, radius, space, typeScale } from '../../src/theme/tokens';
import { AppBar, Avatar, EmptyState, ErrorState, Icon, Screen, SectionHeader, Skeleton, Text } from '../../src/ui';

export default function Search() {
  const router = useRouter();
  const { palette } = useTheme();
  const [query, setQuery] = useState('');
  const results = useCatalogueSearch(query);
  const typed = query.trim();
  const shops = results.data?.shops ?? [];
  const products = results.data?.products ?? [];

  return (
    <Screen testID="search">
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
            borderColor: palette.edge,
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
            testID="search-input"
            style={{ flex: 1, fontFamily: fontFamily.medium, fontSize: typeScale.body.fontSize, color: palette.text }}
          />
        </View>

        {typed.length < SEARCH_MIN_LENGTH || results.tooShort ? (
          <Text variant="caption" tone="muted">
            {typed.length === 0
              ? results.live
                ? 'Search for a shop or a product, like “rice” or “fan”.'
                : 'Try “iPhone” or “TechWorld”.'
              : 'Keep typing: at least two letters.'}
          </Text>
        ) : results.status === 'loading' ? (
          <View style={{ gap: space.md }} accessibilityLabel="Searching">
            <Skeleton style={{ height: 52, borderRadius: 12 }} />
            <Skeleton style={{ height: 52, borderRadius: 12 }} />
          </View>
        ) : results.status === 'error' ? (
          <ErrorState title="Search did not work" message={results.error ?? 'Please try again.'} onRetry={results.retry} />
        ) : shops.length === 0 && products.length === 0 ? (
          <EmptyState icon="magnify" title="No results" body={`Nothing matched “${typed}”. Check the spelling or try something broader.`} />
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
                    <Avatar source={null} name={shop.name} size={44} />
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
                    onPress={() => router.push({ pathname: '/product/[id]', params: { id: product.id, store: product.merchantSlug } })}
                    accessibilityRole="button"
                    accessibilityLabel={`${product.name}, ${formatNairaCompact(product.price)}, from ${product.merchantName}`}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm }}
                  >
                    <View style={{ width: 52, height: 52, borderRadius: radius.md, backgroundColor: palette.surfaceMuted, overflow: 'hidden' }}>
                      <ProductArt product={{ image: product.image ?? null, name: product.name }} style={{ width: '100%', height: '100%' }} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text variant="label" weight="bold" numberOfLines={1}>
                        {product.name}
                      </Text>
                      <Text variant="caption" tone="muted" numberOfLines={1}>
                        {formatNairaCompact(product.price)} · {product.merchantName}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </>
        )}
        {results.live ? null : <SampleDataNote />}
      </View>
    </Screen>
  );
}
