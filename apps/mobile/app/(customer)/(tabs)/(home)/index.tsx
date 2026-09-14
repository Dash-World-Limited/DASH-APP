/**
 * Customer Home — the Customer board, screen 1.
 *
 * Top to bottom, as approved: the DASH wordmark with the profile avatar; where
 * the order is going, with notifications; search, with filters inside the
 * field; the six services as equal doors; and one campaign.
 *
 * The six doors come from the shared service contract (served by the API when
 * this build has one), so their ids and order can never drift from the web or
 * the analytics. Only their illustration and copy are drawn here.
 */

import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';

import avatar from '../../../../assets/staging/customer/avatar-customer.png';
import heroFood from '../../../../assets/staging/customer/home-hero-food.png';
import { Wordmark } from '../../../../src/brand/Wordmark';
import { PromoCard, type Campaign } from '../../../../src/commerce/Promotions';
import { ServiceTile } from '../../../../src/commerce/ServiceTile';
import { useServiceTiles } from '../../../../src/data/useServiceTiles';
import { useTheme } from '../../../../src/theme/ThemeProvider';
import { space } from '../../../../src/theme/tokens';
import { Avatar, Icon, IconButton, Screen, SearchField, Text } from '../../../../src/ui';

/** Campaign content — see PromoCard. The board's Food campaign. */
const FOOD_CAMPAIGN: Campaign = {
  title: 'Good Food\nBrighter Days',
  body: 'Order from your favourite restaurants',
  action: 'Order Now',
  image: heroFood,
  ground: '#EBE1D3',
  ink: '#4E330B',
};

export default function CustomerHome() {
  const router = useRouter();
  const { palette } = useTheme();
  const tiles = useServiceTiles();
  const rows = [tiles.slice(0, 3), tiles.slice(3, 6)];

  return (
    <Screen testID="customer-home">
      <View style={{ paddingHorizontal: space.gutter, gap: space.lg }}>
        <View style={{ height: 52, alignItems: 'center', justifyContent: 'center' }}>
          <Wordmark />
          <Pressable
            onPress={() => router.push('/account')}
            accessibilityRole="button"
            accessibilityLabel="Your profile and settings"
            hitSlop={8}
            style={{ position: 'absolute', right: 0 }}
          >
            <Avatar source={avatar} name="Your profile" size={38} />
          </Pressable>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Pressable
            onPress={() => router.push('/settings/addresses')}
            accessibilityRole="button"
            accessibilityLabel="Delivering to Lekki Phase 1, Lagos. Change delivery address"
            style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm }}
          >
            <Icon name="map-marker-outline" size={22} color={palette.text} />
            <View>
              <Text variant="micro" tone="muted" weight="medium">
                Delivering to
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                <Text variant="label" weight="bold">
                  Lekki Phase 1, Lagos
                </Text>
                <Icon name="chevron-down" size={18} color={palette.text} />
              </View>
            </View>
          </Pressable>
          <IconButton icon="bell-outline" label="Notifications" onPress={() => router.push('/notifications')} />
        </View>

        <SearchField
          placeholder="Search restaurants, shops, pharmacy..."
          editable={false}
          onPress={() => router.push('/search')}
          onFilter={() => router.push('/search')}
        />

        <View accessibilityRole="menu" accessibilityLabel="DASH services" style={{ gap: space.md }}>
          {rows.map((row, index) => (
            <View key={index} style={{ flexDirection: 'row', gap: space.md }}>
              {row.map((tile) => (
                <ServiceTile key={tile.id} tile={tile} onPress={() => router.push(tile.href)} />
              ))}
            </View>
          ))}
        </View>

        <PromoCard campaign={FOOD_CAMPAIGN} onPress={() => router.push('/service/food')} />
      </View>
    </Screen>
  );
}
