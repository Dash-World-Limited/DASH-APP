/**
 * Rider Home — the Rider board, screen 1.
 *
 * Operational first: who you are, what you have earned today, whether you are
 * Online — the largest control on the screen — how the day is going, and where
 * you are working. Readable at arm's length in daylight, and one thumb from
 * going Online or Offline.
 *
 * STAGING DATA. Earnings, trips, rating and completion are sample figures, and
 * the Online switch is local to this build — see features/RiderShift.
 */

import { formatNairaCompact } from '@dash/domain/money';
import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';

import heroScooter from '../../../../assets/staging/rider/home-hero-scooter.png';
import { Wordmark } from '../../../../src/brand/Wordmark';
import { PromoCard, SampleDataNote, type Campaign } from '../../../../src/commerce/Promotions';
import { RIDER_PROFILE, RIDER_TODAY, RIDER_ZONE } from '../../../../src/data/staging';
import { useRiderShift } from '../../../../src/features/RiderShift';
import { formatRating, greetingFor } from '../../../../src/lib/format';
import { useTheme } from '../../../../src/theme/ThemeProvider';
import { radius, space } from '../../../../src/theme/tokens';
import { Avatar, Card, Icon, Screen, Text, Toggle } from '../../../../src/ui';

const RIDER_CAMPAIGN: Campaign = {
  title: 'Deliver\nMore Possibilities',
  body: 'Good food. Happy people.',
  image: heroScooter,
  ground: '#CB9E61',
  ink: '#0B0D10',
};

export default function RiderHome() {
  const router = useRouter();
  const { palette } = useTheme();
  const { online, setOnline } = useRiderShift();

  const goOnline = (next: boolean): void => {
    setOnline(next);
    if (next) router.push('/rider/online');
  };

  return (
    <Screen testID="rider-home">
      <View style={{ paddingHorizontal: space.gutter, gap: space.md }}>
        <View style={{ height: 52, alignItems: 'center', justifyContent: 'center' }}>
          <Wordmark height={26} />
          <Pressable
            onPress={() => router.push('/rider/profile')}
            accessibilityRole="button"
            accessibilityLabel="Your profile and settings"
            hitSlop={8}
            style={{ position: 'absolute', right: 0 }}
          >
            <Avatar source={RIDER_PROFILE.avatar} name={RIDER_PROFILE.firstName} size={38} />
          </Pressable>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View>
            <Text variant="body" tone="muted">
              {greetingFor(new Date().getHours())},
            </Text>
            <Text variant="title" accessibilityRole="header">
              {RIDER_PROFILE.firstName}
            </Text>
          </View>
          <Card tone="muted" padded={false} style={{ paddingHorizontal: space.md, paddingVertical: space.sm, alignItems: 'center' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Text variant="label" weight="bold">
                {formatRating(RIDER_PROFILE.rating)}
              </Text>
              <Icon name="star" size={15} color={palette.rating} />
            </View>
            <Text variant="micro" tone="muted" weight="medium">
              {RIDER_PROFILE.trips} trips
            </Text>
          </Card>
        </View>

        <Pressable
          onPress={() => router.push('/rider/earnings')}
          accessibilityRole="button"
          accessibilityLabel={`Today's earnings, ${formatNairaCompact(RIDER_TODAY.earnings)}. Open earnings`}
        >
          <Card style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Text variant="caption" tone="muted">
                Today&apos;s Earnings
              </Text>
              <Text variant="display">{formatNairaCompact(RIDER_TODAY.earnings)}</Text>
            </View>
            <Icon name="chevron-right" size={26} color={palette.accent} />
          </Card>
        </Pressable>

        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <View
            style={{
              width: 22,
              height: 22,
              borderRadius: 11,
              backgroundColor: online ? palette.successSoft : palette.sand,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: online ? palette.success : palette.textSubtle }} />
          </View>
          <Text variant="heading" style={{ flex: 1 }}>
            {online ? 'Online' : 'Offline'}
          </Text>
          <Toggle value={online} onValueChange={goOnline} label={online ? 'Online. Go offline' : 'Offline. Go online'} />
        </Card>

        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Stat value={String(RIDER_TODAY.trips)} label="Trips" />
          <Stat value={formatRating(RIDER_TODAY.rating)} label="Rating" />
          <Stat value={`${RIDER_TODAY.completion}%`} label="Completion" />
        </View>

        <Card style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md }}>
          <Icon name="map-marker" size={24} color={palette.accent} />
          <View style={{ flex: 1 }}>
            <Text variant="caption" tone="muted">
              Current Zone
            </Text>
            <Text variant="label" weight="bold">
              {RIDER_ZONE.name}
            </Text>
            <Text variant="caption" tone="muted">
              {RIDER_ZONE.region}
            </Text>
          </View>
          <Pressable onPress={() => router.push('/settings/zone')} accessibilityRole="link" hitSlop={10}>
            <Text variant="label" tone="accent">
              Change
            </Text>
          </Pressable>
        </Card>

        <PromoCard campaign={RIDER_CAMPAIGN} height={120} onPress={() => router.push('/rider/earnings')} />
        <SampleDataNote />
      </View>
    </Screen>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <Card tone="muted" padded={false} style={{ flex: 1, alignItems: 'center', paddingVertical: space.md, borderRadius: radius.lg }}>
      <Text variant="heading">{value}</Text>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
    </Card>
  );
}
