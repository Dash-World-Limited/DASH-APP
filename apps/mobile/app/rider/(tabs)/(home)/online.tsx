/**
 * You're Online — the Rider board, screen 2.
 *
 * The calm between deliveries: a slow pulse that says the app is listening,
 * what it is waiting for, how busy the area is, and the zone. Motion here is
 * deliberately slow and small — it runs for a whole shift, so it has to be
 * cheap on a mid-range phone and easy to look away from.
 *
 * Two additions to the board, both about control rather than decoration:
 *
 * - **Go Offline.** The board has no way off this screen but the tab bar. A
 *   rider must always be one tap from stopping, and going Offline must stop
 *   everything — so the control is here, plainly.
 * - **Preview an incoming order**, in development and staging builds only. The
 *   real trigger is a push or a realtime event from dispatch, which this
 *   checkpoint does not connect to; the preview opens the same screen with
 *   staging data so it can be reviewed.
 *
 * STAGING: the demand chart and "High demand" line are sample content. The
 * backend serves no demand signal yet, and a rider must never be told it is
 * busy when it is not.
 */

import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, View } from 'react-native';

import { buildVariant } from '../../../../src/api';
import { RIDER_LIVE_ACTIVITY, RIDER_ZONE } from '../../../../src/data/staging';
import { useRiderShift } from '../../../../src/features/RiderShift';
import { useTheme } from '../../../../src/theme/ThemeProvider';
import { radius, space } from '../../../../src/theme/tokens';
import { Button, Card, Icon, Screen, StatusPill, Text } from '../../../../src/ui';

export default function RiderOnline() {
  const router = useRouter();
  const { palette } = useTheme();
  const { setOnline } = useRiderShift();
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (reduce) return;
      loop = Animated.loop(
        Animated.timing(pulse, { toValue: 1, duration: 2200, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      );
      loop.start();
    });
    return () => loop?.stop();
  }, [pulse]);

  const goOffline = (): void => {
    setOnline(false);
    router.back();
  };

  return (
    <Screen testID="rider-online">
      <View style={{ paddingHorizontal: space.gutter, gap: space.lg }}>
        <View style={{ alignItems: 'center', paddingTop: space.lg }}>
          <Text variant="title" accessibilityRole="header">
            You&apos;re Online
          </Text>
          <Text variant="body" tone="muted">
            Ready to receive orders
          </Text>
        </View>

        <View style={{ height: 200, alignItems: 'center', justifyContent: 'center' }} accessible accessibilityLabel="Looking for nearby orders">
          {[1, 0.72, 0.46].map((scale, index) => (
            <Animated.View
              key={index}
              style={{
                position: 'absolute',
                width: 190 * scale,
                height: 190 * scale,
                borderRadius: 95 * scale,
                backgroundColor: palette.accentSoft,
                opacity: index === 0 ? pulse.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0.35] }) : 0.9,
                transform: index === 0 ? [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.04] }) }] : [],
              }}
            />
          ))}
          <View
            style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: palette.accent, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="moped" size={32} color={palette.onAccent} />
          </View>
        </View>

        <View style={{ alignItems: 'center', gap: space.xs }}>
          <Text variant="heading">Looking for nearby orders...</Text>
          <Text variant="caption" tone="muted" align="center">
            We&apos;ll notify you when a new order is available.
          </Text>
        </View>

        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.md }}>
            <Text variant="label" weight="bold">
              Live Activity
            </Text>
            <StatusPill label="Staging sample" tone="neutral" dot={false} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 44 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {RIDER_LIVE_ACTIVITY.map((level, index) => (
              <View
                key={index}
                style={{ flex: 1, height: Math.max(6, level * 44), borderRadius: 3, backgroundColor: index % 3 === 1 ? palette.accentSoft : palette.accent }}
              />
            ))}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.md }}>
            <Icon name="fire" size={20} color={palette.map.destinationPin} />
            <View>
              <Text variant="label" weight="bold">
                High demand in your area
              </Text>
              <Text variant="caption" tone="muted">
                More orders than usual
              </Text>
            </View>
          </View>
        </Card>

        <Pressable onPress={() => router.push('/rider/settings/zone')} accessibilityRole="button" accessibilityLabel={`Current zone, ${RIDER_ZONE.name}`}>
          <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <Icon name="map-marker" size={24} color={palette.accent} />
            <View style={{ flex: 1 }}>
              <Text variant="caption" tone="muted">
                Current Zone
              </Text>
              <Text variant="label" weight="bold">
                {RIDER_ZONE.name}
              </Text>
            </View>
            <Icon name="chevron-right" size={22} color={palette.textSubtle} />
          </Card>
        </Pressable>

        {buildVariant !== 'production' ? (
          <Button
            label="Preview an incoming order"
            variant="outline"
            leadingIcon="bell-ring-outline"
            accessibilityHint="Staging only. Opens the incoming order screen with sample data."
            onPress={() => router.push('/rider/offer/staging-offer-1')}
            testID="preview-offer"
          />
        ) : null}
        <Button label="Go Offline" variant="secondary" onPress={goOffline} testID="go-offline" style={{ borderRadius: radius.md }} />
      </View>
    </Screen>
  );
}
