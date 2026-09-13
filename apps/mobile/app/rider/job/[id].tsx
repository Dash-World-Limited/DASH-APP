/**
 * Order Details — the Rider board, screen 4.
 *
 * After acceptance: the merchant, both stops, the customer, what to collect,
 * and the note that matters at the counter. The rider is now assigned and has
 * to go to the drop-off, so the server gives the address line and a contact
 * phone — and the call and message buttons use exactly that, through the
 * phone's own dialler and messages app. There is no in-app chat to pretend to.
 *
 * STAGING DATA. The customer's name and rating on this screen are the board's:
 * the delivery projection does not carry a customer name today, and customer
 * ratings are not a DASH concept. Adding first name and initial after
 * acceptance is a proposed projection change awaiting approval — see
 * data/models.ts.
 */

import { Image } from 'expo-image';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { SampleDataNote } from '../../../src/commerce/Promotions';
import { STAGING_JOB } from '../../../src/data/staging';
import { formatRating } from '../../../src/lib/format';
import { RouteStops } from '../../../src/rider/RouteStops';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { radius, space } from '../../../src/theme/tokens';
import { ActionFooter, AppBar, Avatar, Button, Card, Icon, IconButton, Screen, Text } from '../../../src/ui';

const VISIBLE_ITEMS = 3;

export default function RiderJob() {
  const router = useRouter();
  const { palette } = useTheme();
  const job = STAGING_JOB;
  const [allItems, setAllItems] = useState(false);
  const items = allItems ? job.items : job.items.slice(0, VISIBLE_ITEMS);
  const call = (phone: string | null): void => {
    if (phone) void Linking.openURL(`tel:${phone}`);
  };

  return (
    <Screen
      testID="rider-job"
      footer={
        <ActionFooter>
          <Button label="Navigate to Pickup" leadingIcon="navigation-variant" onPress={() => router.push(`/rider/route/${job.id}`)} testID="navigate-to-pickup" />
        </ActionFooter>
      }
    >
      <AppBar
        title="Order Details"
        onBack={() => router.replace('/rider')}
        right={
          <Text variant="micro" tone="muted" weight="medium" style={{ paddingRight: space.md }}>
            #{job.code}
          </Text>
        }
      />
      <View style={{ paddingHorizontal: space.gutter, gap: space.lg }}>
        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          {job.merchant.image ? (
            <Image source={job.merchant.image} style={{ width: 56, height: 56, borderRadius: radius.md }} contentFit="cover" />
          ) : null}
          <View style={{ flex: 1 }}>
            <Text variant="heading">{job.merchant.name}</Text>
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {job.merchant.address.split(', ').pop()}
            </Text>
            {job.merchant.rating ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Icon name="star" size={14} color={palette.rating} />
                <Text variant="caption" weight="semibold">
                  {formatRating(job.merchant.rating.average)}
                </Text>
                <Text variant="caption" tone="muted">
                  ({job.merchant.rating.count})
                </Text>
              </View>
            ) : null}
          </View>
          <IconButton icon="phone" label={`Call ${job.merchant.name}`} plate="surface" size={20} onPress={() => call(job.merchant.phone)} />
          <IconButton
            icon="navigation-variant"
            label={`Route to ${job.merchant.name}`}
            plate="surface"
            size={20}
            onPress={() => router.push(`/rider/route/${job.id}`)}
          />
        </Card>

        <RouteStops
          pickup={{ title: job.merchant.name, detail: job.merchant.address }}
          dropoff={{ title: job.customer.displayName ?? 'Customer', detail: job.dropoff.line1 }}
        />

        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Avatar name={job.customer.displayName ?? 'Customer'} size={48} />
          <View style={{ flex: 1 }}>
            <Text variant="label" weight="bold">
              {job.customer.displayName ?? 'Customer'}
            </Text>
            {job.customer.rating ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Icon name="star" size={14} color={palette.rating} />
                <Text variant="caption" weight="semibold">
                  {formatRating(job.customer.rating.average)}
                </Text>
                <Text variant="caption" tone="muted">
                  ({job.customer.rating.orders} orders)
                </Text>
              </View>
            ) : null}
          </View>
          <IconButton icon="phone" label="Call the customer" plate="surface" size={20} onPress={() => call(job.dropoff.contactPhone)} />
          <IconButton
            icon="message-text-outline"
            label="Text the customer"
            plate="surface"
            size={20}
            onPress={() => job.dropoff.contactPhone && void Linking.openURL(`sms:${job.dropoff.contactPhone}`)}
          />
        </Card>

        <View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: space.sm }}>
            <Text variant="label" weight="bold">
              Order Items ({job.items.length})
            </Text>
            {job.items.length > VISIBLE_ITEMS ? (
              <Pressable onPress={() => setAllItems((v) => !v)} accessibilityRole="button" hitSlop={10}>
                <Text variant="label" tone="accent">
                  {allItems ? 'Show Less' : 'View All'}
                </Text>
              </Pressable>
            ) : null}
          </View>
          {items.map((item) => (
            <Text key={item.name} variant="body" style={{ paddingVertical: 3 }}>
              <Text variant="body" tone="muted">
                {item.quantity}x{'  '}
              </Text>
              {item.name}
            </Text>
          ))}
        </View>

        {job.pickupNote ? (
          <Card tone="sand" style={{ flexDirection: 'row', gap: space.md }}>
            <Icon name="note-text-outline" size={20} color={palette.accent} />
            <View style={{ flex: 1 }}>
              <Text variant="label" weight="bold">
                Pickup Note
              </Text>
              <Text variant="caption" tone="muted">
                {job.pickupNote}
              </Text>
            </View>
          </Card>
        ) : null}
        <SampleDataNote />
      </View>
    </Screen>
  );
}
