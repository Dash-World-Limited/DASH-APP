/**
 * Applying to ride for DASH.
 *
 * An application is a request, not an approval: a rider is `pending` until an
 * administrator decides, and this screen never implies otherwise. When an
 * application already exists the screen shows the server's own status wording
 * rather than guessing what it means.
 *
 * The server requires a verified account before it will accept an
 * application, so the signed-out and unverified cases are refusals it will
 * make anyway — shown here before the request rather than after it.
 */

import { RIDER_VEHICLE_TYPES, type RiderVehicleType } from '@dash/domain/onboarding';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, TextInput, View } from 'react-native';

import { api, ApiError } from '../../api';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, space } from '../../theme/tokens';
import { Text } from '../../ui/Text';
import { useAppSession } from '../auth/AppSessionProvider';
import { BackHeader, Card, Empty, Notice, OrderPage, PrimaryCheckoutButton } from '../orders/parts';

interface Application {
  riderId: string;
  vehicleType: string;
  status: { label: string; body?: string };
  submittedAt?: string;
  approvedAt?: string | null;
}

const VEHICLE_LABELS: Record<RiderVehicleType, string> = {
  motorcycle: 'Motorcycle',
  bicycle: 'Bicycle',
  car: 'Car',
  van: 'Van',
  on_foot: 'On foot',
};

const describeError = (error: unknown): string =>
  error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';

export function RiderApplyScreen({ onBack, onAccount }: { onBack: () => void; onAccount: () => void }) {
  const { palette } = useTheme();
  const auth = useAppSession();
  const [application, setApplication] = useState<Application | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vehicleType, setVehicleType] = useState<RiderVehicleType>('motorcycle');
  const [plate, setPlate] = useState('');

  const load = useCallback(async () => {
    if (!api.configured || auth.state !== 'authenticated') {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await api.request<{ application: Application }>('/v1/rider/application');
      setApplication(result.application);
      setError(null);
    } catch (caught) {
      // 404 is the normal answer for someone who has never applied.
      if (caught instanceof ApiError && caught.status === 404) setApplication(null);
      else setError(describeError(caught));
    } finally {
      setLoading(false);
    }
  }, [auth.state]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.request<{ application: Application }>('/v1/rider/applications', {
        method: 'POST',
        body: { vehicleType, ...(plate.trim() ? { vehiclePlate: plate.trim() } : {}) },
      });
      setApplication(result.application);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  if (!api.configured) {
    return (
      <OrderPage>
        <BackHeader title="Apply to ride" onBack={onBack} />
        <Empty icon="cloud-off-outline" title="Not connected to DASH" body="This build has no DASH API address, so an application cannot be submitted." />
      </OrderPage>
    );
  }
  if (auth.state !== 'authenticated') {
    return (
      <OrderPage>
        <BackHeader title="Apply to ride" onBack={onBack} />
        <Empty icon="account-lock-outline" title="Sign in to apply" body="Riding for DASH needs a verified DASH account." action="Open account" onPress={onAccount} />
      </OrderPage>
    );
  }

  return (
    <OrderPage testID="rider-apply-v2">
      <BackHeader title="Apply to ride" onBack={onBack} />
      {loading ? <View style={{ minHeight: 200, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator /></View> : null}

      {!loading && application ? (
        <Card>
          <Text variant="heading">{application.status.label}</Text>
          {application.status.body ? <Text variant="caption" tone="muted">{application.status.body}</Text> : null}
          <Text variant="caption" tone="muted">
            {VEHICLE_LABELS[application.vehicleType as RiderVehicleType] ?? application.vehicleType}
            {application.submittedAt ? ` · applied ${new Date(application.submittedAt).toLocaleDateString()}` : ''}
          </Text>
          <Notice icon="information-outline" text="A DASH administrator reviews every application. You will see the Rider face become available here once yours is approved." />
        </Card>
      ) : null}

      {!loading && !application ? (
        <>
          <Card>
            <Text variant="heading">Ride with DASH</Text>
            <Text variant="caption" tone="muted">Tell us how you will be delivering. An administrator reviews every application; applying does not approve you.</Text>
          </Card>
          <Card>
            <Text variant="label" weight="bold">How will you deliver?</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }} accessibilityRole="radiogroup">
              {RIDER_VEHICLE_TYPES.map((type) => {
                const active = type === vehicleType;
                return (
                  <Pressable
                    key={type}
                    onPress={() => setVehicleType(type)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={VEHICLE_LABELS[type]}
                    style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: space.lg, borderRadius: radius.pill, backgroundColor: active ? palette.inverse : palette.surface, borderWidth: 1, borderColor: active ? palette.inverse : palette.line }}
                  >
                    <Text variant="caption" weight="bold" tone={active ? 'onInverse' : 'default'}>{VEHICLE_LABELS[type]}</Text>
                  </Pressable>
                );
              })}
            </View>
          </Card>
          {vehicleType !== 'bicycle' && vehicleType !== 'on_foot' ? (
            <Card>
              <Text variant="label" weight="bold">Vehicle plate (optional)</Text>
              <TextInput
                value={plate}
                onChangeText={setPlate}
                autoCapitalize="characters"
                maxLength={16}
                placeholder="ABC 123 XY"
                placeholderTextColor={palette.textSubtle}
                accessibilityLabel="Vehicle plate number"
                style={{ minHeight: 48, borderRadius: radius.md, borderWidth: 1, borderColor: palette.line, paddingHorizontal: space.md, color: palette.text, fontFamily: 'Manrope_500Medium', fontSize: 15 }}
              />
            </Card>
          ) : null}
          <Notice icon="shield-check-outline" text="DASH verifies riders before they can accept deliveries. You may be asked for identification and vehicle documents during review." />
          <PrimaryCheckoutButton label={busy ? 'Submitting…' : 'Submit application'} onPress={() => void submit()} disabled={busy} busy={busy} />
        </>
      ) : null}

      {error ? <Notice icon="alert-circle-outline" text={error} danger /> : null}
    </OrderPage>
  );
}
