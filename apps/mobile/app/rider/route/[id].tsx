/**
 * Pickup Route — the Rider board, screen 5. The representative native map.
 *
 * A real platform map takes the top of the screen: the route, the rider and
 * the merchant. Beneath it, the time and distance to the merchant, the
 * merchant with a call button, and their note for riders.
 *
 * "Navigate" hands the trip to the phone's own navigation app with the
 * merchant as the destination — turn-by-turn is a solved problem the rider
 * already has, and DASH does not rebuild it. The route line and ETA here are
 * staging values until a routing provider sits behind the maps adapter.
 *
 * The board shows a small icon in the top-right of this screen whose purpose
 * it does not make clear; it is left out rather than drawn as a control that
 * does nothing.
 */

import { Image } from 'expo-image';
import * as Linking from 'expo-linking';
import { Platform, ScrollView, View, useWindowDimensions } from 'react-native';

import { SampleDataNote } from '../../../src/commerce/Promotions';
import { RIDER_POSITION, STAGING_JOB } from '../../../src/data/staging';
import { formatDistance } from '../../../src/lib/format';
import { MapShell } from '../../../src/rider/MapShell';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { elevation, radius, space } from '../../../src/theme/tokens';
import { AppBar, Button, Card, Icon, IconButton, Screen, Text } from '../../../src/ui';

export default function PickupRoute() {
  const { palette } = useTheme();
  const { height } = useWindowDimensions();
  const job = STAGING_JOB;
  // The map is not inside the scroll view — panning a map inside one fights the
  // page scroll on Android. It takes a fixed share of the screen instead.
  const mapHeight = Math.max(260, Math.round(height * 0.42));
  const { latitude, longitude } = job.merchant.coordinate;

  const openNavigation = (): void => {
    const label = encodeURIComponent(job.merchant.name);
    const url =
      Platform.OS === 'ios'
        ? `maps://?daddr=${latitude},${longitude}&q=${label}`
        : `google.navigation:q=${latitude},${longitude}`;
    void Linking.openURL(url).catch(() =>
      Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}`),
    );
  };

  return (
    <Screen testID="pickup-route" scroll={false}>
      <AppBar title="Navigate" />
      <MapShell
        route={job.routeToPickup}
        rider={RIDER_POSITION}
        destination={job.merchant.coordinate}
        routeColor={palette.map.routeToPickup}
        destinationIcon="silverware-fork-knife"
        height={mapHeight}
        accessibilityLabel={`Map of the route to ${job.merchant.name}`}
      />
      <ScrollView
        style={{
          flex: 1,
          marginTop: -space.xl,
          backgroundColor: palette.background,
          borderTopLeftRadius: radius.xl,
          borderTopRightRadius: radius.xl,
          ...elevation.floating,
        }}
        contentContainerStyle={{ paddingHorizontal: space.gutter, paddingTop: space.lg, paddingBottom: space.xxl, gap: space.md }}
      >
        <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: palette.line }} />
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ flex: 1 }}>
            <Text variant="title">
              {job.etaToPickupMinutes} min{' '}
              <Text variant="body" tone="muted">
                ({formatDistance(job.distanceToPickupMetres)})
              </Text>
            </Text>
            <Text variant="caption" tone="muted">
              Arriving at merchant
            </Text>
          </View>
          <Button label="Navigate" variant="outline" size="md" leadingIcon="navigation-variant" onPress={openNavigation} testID="open-navigation" />
        </View>

        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          {job.merchant.image ? (
            <Image source={job.merchant.image} style={{ width: 48, height: 48, borderRadius: radius.md }} contentFit="cover" />
          ) : null}
          <View style={{ flex: 1 }}>
            <Text variant="label" weight="bold">
              {job.merchant.name}
            </Text>
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {job.merchant.address}
            </Text>
          </View>
          <IconButton
            icon="phone"
            label={`Call ${job.merchant.name}`}
            plate="surface"
            size={20}
            onPress={() => job.merchant.phone && void Linking.openURL(`tel:${job.merchant.phone}`)}
          />
        </Card>

        <Card tone="sand" style={{ flexDirection: 'row', gap: space.md }}>
          <Icon name="note-text-outline" size={20} color={palette.accent} />
          <Text variant="caption" tone="muted" style={{ flex: 1 }}>
            Look for the main entrance. Parking available for riders.
          </Text>
        </Card>
        <SampleDataNote />
      </ScrollView>
    </Screen>
  );
}
