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
import * as Location from 'expo-location';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';

import { api } from '../../../src/api';
import { ApiError } from '../../../src/api/errors';
import { SampleDataNote } from '../../../src/commerce/Promotions';
import { completeDelivery, getDelivery, headingToPickup, nextStep, PIN_PATTERN, progressDelivery, type RiderDelivery } from '../../../src/data/rider';
import { STAGING_JOB } from '../../../src/data/staging';
import { useRiderShift } from '../../../src/features/RiderShift';
import { formatRating } from '../../../src/lib/format';
import { RouteStops } from '../../../src/rider/RouteStops';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { radius, space } from '../../../src/theme/tokens';
import { ActionFooter, AppBar, Avatar, Button, Card, CodeField, EmptyState, Icon, IconButton, Screen, Text } from '../../../src/ui';

const VISIBLE_ITEMS = 3;

export default function RiderJob() {
  const { live } = useRiderShift();
  return live ? <LiveJob /> : <PreviewJob />;
}

/**
 * The real delivery. The address and the customer's phone arrive only now,
 * after acceptance. Each step is one button in the server's order; the last
 * is the four-digit PIN the customer reads out, which the server checks.
 * Navigation hands over to the phone's maps app; calls and messages use the
 * phone's own dialler and messages app.
 */
function LiveJob() {
  const router = useRouter();
  const { palette } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [job, setJob] = useState<RiderDelivery | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [pin, setPin] = useState('');

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setJob(await getDelivery(api, id));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof ApiError ? error.message : 'This delivery could not load.');
    }
  }, [id]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  if (loadError && !job) {
    return (
      <Screen>
        <AppBar title="Delivery" onBack={() => router.replace('/rider')} />
        <View style={{ padding: space.gutter }}>
          <EmptyState icon="alert-circle-outline" title="Could not load" body={loadError} action="Try again" onAction={() => void load()} />
        </View>
      </Screen>
    );
  }
  if (!job) {
    return (
      <Screen>
        <AppBar title="Delivery" onBack={() => router.replace('/rider')} />
        <View style={{ padding: space.gutter }}>
          <Text variant="caption" tone="muted">
            Loading the delivery…
          </Text>
        </View>
      </Screen>
    );
  }

  const step = nextStep(job.status);
  const toPickup = headingToPickup(job.status);
  const destination = toPickup ? job.branch : job.address;
  const openMaps = (): void => {
    if (!destination) return;
    void Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${destination.latitude},${destination.longitude}`);
  };

  async function advance() {
    if (!job || !step) return;
    setBusy(true);
    setProblem(null);
    try {
      if (step.kind === 'progress') {
        await progressDelivery(api, job.id, step.to);
      } else {
        const here = await Location.getLastKnownPositionAsync().catch(() => null);
        await completeDelivery(api, job.id, pin, here ? { latitude: here.coords.latitude, longitude: here.coords.longitude } : undefined);
        setPin('');
      }
      await load();
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : 'That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const delivered = job.status === 'delivered';
  return (
    <Screen
      testID="rider-job"
      footer={
        <ActionFooter>
          {delivered ? (
            <Button label="Back to Home" onPress={() => router.replace('/rider')} />
          ) : step ? (
            <Button
              label={step.label}
              onPress={() => void advance()}
              busy={busy}
              disabled={step.kind === 'complete' && !PIN_PATTERN.test(pin)}
              testID="delivery-next-step"
            />
          ) : null}
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
        {delivered ? (
          <Card tone="sand">
            <Text variant="heading">Delivered</Text>
            <Text variant="caption" tone="muted">
              The customer&apos;s PIN matched. This delivery is complete.
            </Text>
          </Card>
        ) : null}

        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <View style={{ flex: 1 }}>
            <Text variant="heading">{job.vendor.name}</Text>
            <Text variant="caption" tone="muted" numberOfLines={2}>
              {job.branch.address}
            </Text>
          </View>
          {job.branch.phone ? <IconButton icon="phone" label={`Call ${job.vendor.name}`} plate="surface" size={20} onPress={() => void Linking.openURL(`tel:${job.branch.phone}`)} /> : null}
        </Card>

        {job.pickupCode ? (
          <Card tone="sand" testID="pickup-code">
            <Text variant="caption" tone="muted">
              Pickup code — show it at the counter
            </Text>
            <Text variant="title" weight="extrabold" accessibilityLabel={`Pickup code ${job.pickupCode.split('').join(' ')}`}>
              {job.pickupCode}
            </Text>
          </Card>
        ) : null}

        <RouteStops
          pickup={{ title: job.vendor.name, detail: job.branch.address }}
          dropoff={{ title: 'Customer', detail: job.address ? `${job.address.line1}${job.address.landmark ? ` · ${job.address.landmark}` : ''}` : 'Collected at the shop' }}
        />

        {job.address && !delivered ? (
          <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <View style={{ flex: 1 }}>
              <Text variant="label" weight="bold">
                Customer
              </Text>
              {job.address.instructions || job.instructions ? (
                <Text variant="caption" tone="muted">
                  {job.address.instructions ?? job.instructions}
                </Text>
              ) : null}
            </View>
            <IconButton icon="phone" label="Call the customer" plate="surface" size={20} onPress={() => void Linking.openURL(`tel:${job.address!.contactPhone}`)} />
            <IconButton icon="message-text-outline" label="Text the customer" plate="surface" size={20} onPress={() => void Linking.openURL(`sms:${job.address!.contactPhone}`)} />
          </Card>
        ) : null}

        {!delivered && destination ? (
          <Button variant="outline" leadingIcon="navigation-variant" label={toPickup ? 'Navigate to the shop' : 'Navigate to the customer'} onPress={openMaps} />
        ) : null}

        <View>
          <Text variant="label" weight="bold" style={{ marginBottom: space.sm }}>
            Order Items ({job.items.length})
          </Text>
          {job.items.map((item, index) => (
            <Text key={`${item.nameSnapshot}-${index}`} variant="body" style={{ paddingVertical: 3 }}>
              <Text variant="body" tone="muted">
                {item.quantity}x{'  '}
              </Text>
              {item.nameSnapshot}
            </Text>
          ))}
        </View>

        {step?.kind === 'complete' ? (
          <Card>
            <View style={{ gap: space.sm }}>
              <Text variant="label" weight="bold">
                Ask the customer for their 4-digit delivery PIN
              </Text>
              <CodeField value={pin} onChangeText={setPin} length={4} />
            </View>
          </Card>
        ) : null}

        {problem ? (
          <Text variant="caption" style={{ color: palette.danger }} accessibilityLiveRegion="polite">
            {problem}
          </Text>
        ) : null}
      </View>
    </Screen>
  );
}

/** The device-only preview, for builds with no server. */
function PreviewJob() {
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
