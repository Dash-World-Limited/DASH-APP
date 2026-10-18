/**
 * Delivery location: opened from the line under DASH on the customer home
 * screen.
 *
 * The customer confirms where they are — the address read from their phone's
 * position, which they can correct before saving — or picks one of their
 * saved addresses. Either becomes their default address, which is what the
 * home screen shows and what checkout picks first. It is saved through the
 * same address routes as everything else; there is no second address store.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { api, ApiError } from '../../api';
import { listAddresses, updateAddress, type Address } from '../../data/orders';
import { describePlace } from '../../features/delivery';
import { openAppSettings, type PlaceResult } from '../../features/deviceLocation';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, space, touchTarget } from '../../theme/tokens';
import { Icon } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useAppSession } from '../auth/AppSessionProvider';
import { NewAddressForm } from './NewAddressForm';
import { BackHeader, Card, Empty, Notice, OrderPage, PrimaryCheckoutButton, SecondaryButton } from './parts';
import { detectPlace, recentDetection, resumePlaceDetection } from './useDeliveryLocation';
import { useIosLocationResume } from './useIosLocationResume';

const describeError = (error: unknown): string =>
  error instanceof ApiError
    ? error.isNetwork
      ? 'DASH could not be reached. Check your connection and try again.'
      : error.message
    : 'Something went wrong. Please try again.';

export function DeliveryLocationScreen({ onBack, onAccount }: { onBack: () => void; onAccount: () => void }) {
  const { palette } = useTheme();
  const { state: sessionState, viewer } = useAppSession();
  const signedIn = sessionState === 'authenticated' && api.configured;

  const [detection, setDetection] = useState<PlaceResult | null>(() => recentDetection());
  const [locating, setLocating] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [choosingId, setChoosingId] = useState<string | null>(null);
  const [chooseError, setChooseError] = useState<string | null>(null);
  const choosing = useRef(false);
  const detectionGeneration = useRef(0);

  const locate = useCallback(async (ask: boolean, resuming = false) => {
    const mine = ++detectionGeneration.current;
    setLocating(true);
    if (resuming) {
      setDetection(null);
    }
    try {
      const result = await (resuming ? resumePlaceDetection() : detectPlace({ ask, fresh: ask }));
      if (mine === detectionGeneration.current) setDetection(result);
    } finally {
      if (mine === detectionGeneration.current) setLocating(false);
    }
  }, []);

  const resume = useCallback(() => {
    // A location already chosen for an address draft is intentional. Keep the
    // customer's typed form intact when switching apps to check an address.
    if (!confirming) void locate(false, true);
  }, [confirming, locate]);
  useIosLocationResume(resume);

  const loadAddresses = useCallback(async () => {
    if (!signedIn) return;
    setListError(null);
    try {
      setAddresses(await listAddresses(api));
    } catch (caught) {
      setListError(describeError(caught));
    }
  }, [signedIn]);

  useEffect(() => {
    // Opening this screen is the customer asking where they are, so a missing
    // permission may be asked for here.
    if (!recentDetection()) void locate(true);
    return () => { detectionGeneration.current += 1; };
  }, [locate]);

  useEffect(() => {
    void loadAddresses();
  }, [loadAddresses]);

  const choose = async (address: Address) => {
    if (choosing.current) return;
    if (address.isDefault) {
      onBack();
      return;
    }
    choosing.current = true;
    setChoosingId(address.id);
    setChooseError(null);
    try {
      await updateAddress(api, address.id, { isDefault: true });
      onBack();
    } catch (caught) {
      setChooseError(describeError(caught));
    } finally {
      choosing.current = false;
      setChoosingId(null);
    }
  };

  const found = detection?.ok ? detection : null;
  const description = found ? describePlace(found.place) : null;

  return (
    <OrderPage testID="delivery-location-v2">
      <BackHeader title="Delivery location" onBack={onBack} />

      {confirming && found && signedIn ? (
        <NewAddressForm
          title="Confirm your delivery location"
          saveLabel="Deliver here"
          defaultPhone={viewer?.identity.phone ?? ''}
          initialLine1={description ?? ''}
          position={{ latitude: found.latitude, longitude: found.longitude }}
          makeDefault
          onSaved={() => onBack()}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <View style={{ width: 40, height: 40, borderRadius: radius.md, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="crosshairs-gps" color={palette.accent} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="micro" tone="muted">Your current location</Text>
              {locating ? (
                <Text variant="label" weight="bold">Finding where you are…</Text>
              ) : found ? (
                <Text variant="label" weight="bold">{description ?? 'We found your position, but not a street address'}</Text>
              ) : (
                <Text variant="label" weight="bold">Location not available</Text>
              )}
            </View>
            {locating ? <ActivityIndicator color={palette.accent} /> : null}
          </View>

          {!locating && detection && !detection.ok ? <Notice icon="map-marker-off-outline" text={detection.message} /> : null}

          {!locating && found ? (
            signedIn ? (
              <PrimaryCheckoutButton label={description ? 'Use this location' : 'Type the address for this spot'} onPress={() => setConfirming(true)} />
            ) : (
              <Notice icon="account-lock-outline" text="Sign in to save this as your delivery location." />
            )
          ) : null}

          {!locating && detection && !detection.ok ? (
            detection.reason === 'denied' && !detection.canAskAgain ? (
              <SecondaryButton label="Open settings" onPress={openAppSettings} />
            ) : (
              <SecondaryButton label={detection.reason === 'denied' ? 'Allow location' : 'Try again'} onPress={() => void locate(true)} />
            )
          ) : null}
          {!locating && found ? <SecondaryButton label="Find me again" onPress={() => void locate(true)} /> : null}
        </Card>
      )}

      {!signedIn ? (
        <Empty
          icon="map-marker-account-outline"
          title="Your saved addresses"
          body="Sign in to choose one of your saved addresses, or to save where you are now."
          action={api.configured ? 'Open account' : undefined}
          onPress={api.configured ? onAccount : undefined}
        />
      ) : confirming ? null : (
        <View style={{ gap: space.sm }}>
          <Text variant="micro" weight="bold" tone="muted" style={{ letterSpacing: 0.6 }}>SAVED ADDRESSES</Text>
          {listError ? <Notice icon="alert-circle-outline" text={listError} danger /> : null}
          {listError ? <SecondaryButton label="Try again" onPress={() => void loadAddresses()} /> : null}
          {!listError && addresses === null ? <ActivityIndicator color={palette.accent} accessibilityLabel="Loading your addresses" /> : null}
          {addresses?.length === 0 ? <Text variant="caption" tone="muted">No saved addresses yet. Confirm your current location above to save your first.</Text> : null}
          {addresses?.map((address) => (
            <Pressable
              key={address.id}
              onPress={() => void choose(address)}
              disabled={choosingId !== null}
              accessibilityRole="radio"
              accessibilityState={{ selected: address.isDefault, disabled: choosingId !== null }}
              accessibilityLabel={`${address.label ?? 'Saved address'}, ${address.line1}${address.isDefault ? ', your delivery location' : ''}`}
              style={({ pressed }) => ({
                minHeight: touchTarget + 16,
                padding: space.md,
                borderRadius: radius.md,
                borderWidth: address.isDefault ? 1.5 : 1,
                borderColor: address.isDefault ? palette.accent : palette.line,
                backgroundColor: pressed ? palette.surfaceMuted : palette.surface,
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.md,
              })}
            >
              <Icon name={address.isDefault ? 'radiobox-marked' : 'radiobox-blank'} color={address.isDefault ? palette.accent : palette.textMuted} />
              <View style={{ flex: 1 }}>
                <Text variant="label" weight="bold">{address.label ?? 'Saved address'}</Text>
                <Text variant="caption" tone="muted">{address.line1}</Text>
              </View>
              {choosingId === address.id ? <ActivityIndicator color={palette.accent} /> : null}
            </Pressable>
          ))}
          {chooseError ? <Notice icon="alert-circle-outline" text={chooseError} danger /> : null}
        </View>
      )}
    </OrderPage>
  );
}
