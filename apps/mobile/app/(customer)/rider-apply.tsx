/**
 * Apply to ride with DASH.
 *
 * An application grants nothing: the founder approves each early rider
 * personally, and only then does "Switch to Rider" appear — the server
 * refuses every rider route until then, whatever this screen shows.
 */

import { RIDER_VEHICLE_TYPES } from '@dash/domain/onboarding';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { api } from '../../src/api';
import { ApiError } from '../../src/api/errors';
import { useAuth } from '../../src/features/AuthProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { space } from '../../src/theme/tokens';
import { AppBar, Button, Card, Chip, EmptyState, Screen, Text, TextField } from '../../src/ui';

const VEHICLE_LABELS: Record<(typeof RIDER_VEHICLE_TYPES)[number], string> = {
  motorcycle: 'Motorcycle',
  bicycle: 'Bicycle',
  car: 'Car',
  van: 'Van',
  on_foot: 'On foot',
};

export default function RiderApply() {
  const router = useRouter();
  const auth = useAuth();
  const { palette } = useTheme();
  const [vehicle, setVehicle] = useState<(typeof RIDER_VEHICLE_TYPES)[number]>('motorcycle');
  const [plate, setPlate] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const status = auth.viewer?.riderStatus ?? null;

  if (auth.state !== 'authenticated') {
    return (
      <Screen>
        <AppBar title="Ride with DASH" back />
        <EmptyState icon="account-lock-outline" title="Sign in first" body="Riders use the same DASH account as customers." action="Sign in" onAction={() => router.push('/sign-in')} />
      </Screen>
    );
  }

  if (submitted || status === 'pending') {
    return (
      <Screen>
        <AppBar title="Ride with DASH" back />
        <EmptyState
          icon="clock-outline"
          title="Pending admin approval"
          body="Thank you. The DASH team reviews every rider personally and will email you. Rider mode appears in your account once you are approved."
          action="Back to account"
          onAction={() => router.replace('/account')}
        />
      </Screen>
    );
  }
  if (status === 'suspended') {
    return (
      <Screen>
        <AppBar title="Ride with DASH" back />
        <EmptyState icon="account-cancel-outline" title="Rider account suspended" body="Contact DASH support if you think this is a mistake." />
      </Screen>
    );
  }

  async function apply() {
    setBusy(true);
    setNotice(null);
    try {
      await api.request('/v1/rider/applications', {
        method: 'POST',
        body: { vehicleType: vehicle, ...(plate.trim() ? { vehiclePlate: plate.trim() } : {}) },
      });
      setSubmitted(true);
      // So the account screen shows "Pending admin approval" too.
      void auth.refreshViewer().catch(() => undefined);
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : 'That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <AppBar title="Ride with DASH" back />
      <View style={{ paddingHorizontal: space.gutter, paddingTop: space.md, gap: space.lg }}>
        {status === 'rejected' ? (
          <Text variant="caption" tone="muted">
            Your last application was not approved. You can apply again.
          </Text>
        ) : null}
        <Text variant="body">Deliver orders from local shops to customers near you. Every rider is approved personally by the DASH team.</Text>
        <Card>
          <View style={{ gap: space.sm }}>
            <Text variant="label">How will you deliver?</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }} accessibilityRole="radiogroup">
              {RIDER_VEHICLE_TYPES.map((type) => (
                <Chip key={type} label={VEHICLE_LABELS[type]} selected={vehicle === type} onPress={() => setVehicle(type)} />
              ))}
            </View>
          </View>
        </Card>
        {vehicle !== 'on_foot' && vehicle !== 'bicycle' ? (
          <TextField label="Plate number (optional)" value={plate} onChangeText={setPlate} autoCapitalize="characters" maxLength={16} />
        ) : null}
        <Text variant="caption" tone="muted">
          While you are online, the app shares your location with DASH so orders near you can be offered. It stops when you go offline or close the app.
        </Text>
        {notice ? (
          <Text variant="caption" style={{ color: palette.danger }} accessibilityLiveRegion="polite">
            {notice}
          </Text>
        ) : null}
        <Button label="Apply to ride" onPress={() => void apply()} busy={busy} />
      </View>
    </Screen>
  );
}
