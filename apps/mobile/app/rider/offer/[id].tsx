/**
 * Incoming Order — the Rider board, screen 3.
 *
 * The one screen allowed to interrupt: the clock, who the order is from, where
 * it goes, what it pays, and two choices. Accept is the largest thing on the
 * screen; Decline is right beneath it and equally easy to reach, because a
 * rider must never accept by accident.
 *
 * ## The one deliberate difference from the board
 *
 * The board names the customer and their street on this screen ("Emma A.,
 * Chevron Drive"). The server does not send that before acceptance, by rule:
 * "a rider who has not accepted yet has no business knowing where the customer
 * lives" (GET /v1/rider/offers). The offer model here has no customer fields
 * at all, so the drop-off shows the coarsened *area* the server does send, and
 * says the address follows acceptance. Reported to the director as a conflict
 * between the approved UI and a privacy rule; the rule has not been weakened.
 *
 * ## What acceptance will mean
 *
 * Wired, Accept is POST /v1/rider/offers/:id/respond, and the server — not this
 * screen — re-checks everything dispatch checked: approval, lease, capacity,
 * zone, distance, and a position no older than 120 seconds. The web client
 * confirms a fresh fix before enabling Accept; the native Rider will do the
 * same when location reporting arrives. In this staging build Accept opens the
 * staging job.
 */

import { formatNairaCompact } from '@dash/domain/money';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';

import { stagingOffer } from '../../../src/data/staging';
import { formatDistance, formatRating } from '../../../src/lib/format';
import { CountdownRing } from '../../../src/rider/CountdownRing';
import { RouteStops } from '../../../src/rider/RouteStops';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { radius, space } from '../../../src/theme/tokens';
import { ActionFooter, AppBar, Button, Card, EmptyState, Icon, Screen, Text } from '../../../src/ui';

export default function IncomingOffer() {
  const router = useRouter();
  const { palette } = useTheme();
  // Staging: one sample offer, its clock started when the screen opened.
  const offer = useMemo(() => stagingOffer(), []);
  const [expired, setExpired] = useState(false);
  const onExpire = useCallback(() => setExpired(true), []);
  const close = (): void => (router.canGoBack() ? router.back() : router.replace('/rider'));

  if (expired) {
    return (
      <Screen>
        <AppBar back={false} title="New Order" />
        <EmptyState
          icon="timer-sand-complete"
          title="This offer has expired"
          body="It has gone to another rider. Stay online — the next one will come to you."
          action="Back to Home"
          onAction={close}
        />
      </Screen>
    );
  }

  const { pickup } = offer.order;
  return (
    <Screen
      testID="incoming-offer"
      footer={
        <ActionFooter>
          <Button label="Accept Order" onPress={() => router.replace(`/rider/job/staging-job-1`)} testID="accept-offer" />
          <Button label="Decline" variant="secondary" onPress={close} testID="decline-offer" />
        </ActionFooter>
      }
    >
      <AppBar title="New Order" backIcon="close" onBack={close} />
      <View style={{ paddingHorizontal: space.gutter, gap: space.lg }}>
        <View style={{ alignItems: 'center', gap: space.xs }}>
          <CountdownRing expiresAt={offer.expiresAt} windowSeconds={offer.windowSeconds} onExpire={onExpire} />
          <Text variant="heading" style={{ marginTop: space.sm }}>
            New order request
          </Text>
          <Text variant="caption" tone="muted">
            Accept within {offer.windowSeconds} seconds
          </Text>
        </View>

        <Card style={{ gap: space.lg }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            {pickup.image ? (
              <Image source={pickup.image} style={{ width: 56, height: 56, borderRadius: radius.md }} contentFit="cover" />
            ) : null}
            <View style={{ flex: 1 }}>
              <Text variant="heading">{pickup.name}</Text>
              {pickup.kind ? (
                <Text variant="caption" tone="muted">
                  {pickup.kind}
                </Text>
              ) : null}
              {pickup.rating ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Icon name="star" size={14} color={palette.rating} />
                  <Text variant="caption" weight="semibold">
                    {formatRating(pickup.rating.average)}
                  </Text>
                  <Text variant="caption" tone="muted">
                    ({pickup.rating.count})
                  </Text>
                </View>
              ) : null}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
              <Icon name="map-marker-outline" size={16} color={palette.accent} />
              <Text variant="caption" weight="semibold">
                {formatDistance(offer.pickupDistanceMetres)}
              </Text>
            </View>
          </View>

          <RouteStops
            pickup={{ title: pickup.name, detail: pickup.address }}
            dropoff={{
              title: offer.order.dropoffArea?.label ?? 'Drop-off area',
              detail: 'Exact address after you accept',
            }}
          />

          <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: palette.line, paddingTop: space.md }}>
            <View style={{ flex: 1 }}>
              <Text variant="title">{offer.estimatedEarnings ? formatNairaCompact(offer.estimatedEarnings) : '—'}</Text>
              <Text variant="caption" tone="muted">
                Estimated earnings
              </Text>
            </View>
            <View style={{ width: 1, backgroundColor: palette.line, marginHorizontal: space.md }} />
            <View style={{ flex: 1 }}>
              <Text variant="title">{formatDistance(offer.order.tripDistanceMetres)}</Text>
              <Text variant="caption" tone="muted">
                Total distance
              </Text>
            </View>
          </View>
        </Card>
      </View>
    </Screen>
  );
}
