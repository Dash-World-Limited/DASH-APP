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
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../../../../src/api';
import { getEarnings, listDeliveries, type RiderDelivery, type RiderEarnings } from '../../../../src/data/rider';
import { useAuth } from '../../../../src/features/AuthProvider';

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
  const { live } = useRiderShift();
  return live ? <LiveRiderHome /> : <PreviewRiderHome />;
}

/**
 * The rider home against the real API: who is signed in, the Online switch
 * (and why it failed, if it did), deliveries in hand, and what DASH owes —
 * from the ledger. Nothing here is a sample figure.
 */
function LiveRiderHome() {
  const router = useRouter();
  const { palette } = useTheme();
  const auth = useAuth();
  const { online, setOnline, switching, problem } = useRiderShift();
  const [deliveries, setDeliveries] = useState<RiderDelivery[] | null>(null);
  const [earnings, setEarnings] = useState<RiderEarnings | null>(null);

  const load = useCallback(async () => {
    try {
      const [inHand, owed] = await Promise.all([listDeliveries(api), getEarnings(api)]);
      setDeliveries(inHand);
      setEarnings(owed);
    } catch {
      // Shown as unknown rather than zero; the next focus tries again.
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const name = auth.viewer?.identity.displayName ?? 'Rider';
  return (
    <Screen testID="rider-home">
      <View style={{ paddingHorizontal: space.gutter, gap: space.md }}>
        <View style={{ height: 52, alignItems: 'center', justifyContent: 'center' }}>
          <Wordmark />
          <Pressable onPress={() => router.push('/rider/profile')} accessibilityRole="button" accessibilityLabel="Your profile and settings" hitSlop={8} style={{ position: 'absolute', right: 0 }}>
            <Avatar name={name} size={38} />
          </Pressable>
        </View>
        <View>
          <Text variant="body" tone="muted">
            {greetingFor(new Date().getHours())},
          </Text>
          <Text variant="title" accessibilityRole="header">
            {name}
          </Text>
        </View>

        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: online ? palette.success : palette.textSubtle }} />
          <Text variant="heading" style={{ flex: 1 }}>
            {switching ? (online ? 'Going offline…' : 'Going online…') : online ? 'Online' : 'Offline'}
          </Text>
          <Toggle value={online} onValueChange={setOnline} disabled={switching} label={online ? 'Online. Go offline' : 'Offline. Go online'} />
        </Card>
        {problem ? (
          <Text variant="caption" style={{ color: palette.danger }} accessibilityLiveRegion="polite">
            {problem}
          </Text>
        ) : null}
        {online ? (
          <Text variant="caption" tone="muted">
            Keep DASH open while you are online. Your location is shared with DASH only while you are online and the app is open.
          </Text>
        ) : null}

        {deliveries && deliveries.length > 0 ? (
          <View style={{ gap: space.sm }}>
            <Text variant="heading">In your hands</Text>
            {deliveries.map((delivery) => (
              <Pressable key={delivery.id} onPress={() => router.push(`/rider/job/${delivery.id}`)} accessibilityRole="button" accessibilityLabel={`Delivery ${delivery.code} from ${delivery.vendor.name}`}>
                <Card>
                  <Text variant="label" weight="bold">
                    {delivery.vendor.name} · #{delivery.code}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {delivery.status.replace(/_/g, ' ')}
                  </Text>
                </Card>
              </Pressable>
            ))}
          </View>
        ) : null}

        <Pressable onPress={() => router.push('/rider/earnings')} accessibilityRole="button" accessibilityLabel="Open earnings">
          <Card style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Text variant="caption" tone="muted">
                Owed to you
              </Text>
              <Text variant="display">{earnings ? formatNairaCompact(earnings.balanceOwed as never) : '—'}</Text>
              <Text variant="caption" tone="muted">
                {earnings ? `${earnings.completedDeliveries} completed deliver${earnings.completedDeliveries === 1 ? 'y' : 'ies'}` : 'Loading…'}
              </Text>
            </View>
            <Icon name="chevron-right" size={26} color={palette.accent} />
          </Card>
        </Pressable>
      </View>
    </Screen>
  );
}

/** The device-only preview, for builds with no server. Every figure is a sample, and it says so. */
function PreviewRiderHome() {
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
          <Wordmark />
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
          <Pressable onPress={() => router.push('/rider/settings/zone')} accessibilityRole="link" hitSlop={10}>
            <Text variant="label" tone="accent">
              Change
            </Text>
          </Pressable>
        </Card>

        <PromoCard campaign={RIDER_CAMPAIGN} height={120} onPress={() => router.push('/rider/campaign')} />
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
