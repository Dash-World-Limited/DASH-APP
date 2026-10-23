/**
 * Deleting a DASH account, from inside the app.
 *
 * Google Play requires an in-app route to account deletion for any app that
 * lets someone create an account, which is why this is a release blocker
 * rather than a nicety.
 *
 * The behaviour is the server's, and this screen states it rather than
 * softening it: a request schedules deletion after a cooling-off period, the
 * person stays signed in and can cancel until the date shown, and only then
 * is anything purged. Nothing here claims data is already gone — the screen
 * shows the status the server reports and the date it gave.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, TextInput, View } from 'react-native';

import { api, ApiError } from '../../api';
import { newIdempotencyKey } from '../../data/orders';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, space } from '../../theme/tokens';
import { Text } from '../../ui/Text';
import { useAppSession } from '../auth/AppSessionProvider';
import { BackHeader, Card, Empty, Notice, OrderPage, PrimaryCheckoutButton, SecondaryButton } from '../orders/parts';

interface Deletion {
  status: string;
  requestedAt: string | null;
  scheduledPurgeAt: string | null;
  cancelledAt?: string | null;
  completedAt?: string | null;
  cancellable: boolean;
}

const describeError = (error: unknown): string =>
  error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';

const formatDate = (value: string | null): string =>
  value ? new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : 'the scheduled date';

export function DeleteAccountScreen({ onBack, onAccount }: { onBack: () => void; onAccount: () => void }) {
  const { palette } = useTheme();
  const auth = useAppSession();
  const [deletion, setDeletion] = useState<Deletion | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  // Keep retries of one request idempotent if the response is lost.
  const attemptKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!api.configured || auth.state !== 'authenticated') {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await api.request<{ deletion: Deletion | null }>('/v1/account/deletion');
      setDeletion(result.deletion);
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setLoading(false);
    }
  }, [auth.state]);

  useEffect(() => {
    void load();
  }, [load]);

  const request = async () => {
    setBusy(true);
    setError(null);
    attemptKey.current ??= newIdempotencyKey();
    try {
      const result = await api.request<{ deletion: Deletion }>('/v1/account/deletion', {
        method: 'POST',
        headers: { 'Idempotency-Key': attemptKey.current },
        body: reason.trim() ? { reason: reason.trim() } : {},
      });
      setDeletion(result.deletion);
      attemptKey.current = null;
      setReason('');
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.request('/v1/account/deletion', { method: 'DELETE' });
      await load();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const confirm = () => {
    Alert.alert(
      'Delete your DASH account?',
      'Your account is scheduled for deletion. You stay signed in and can cancel until the date shown. After that, your account and personal data are permanently removed.',
      [
        { text: 'Keep my account', style: 'cancel' },
        { text: 'Schedule deletion', style: 'destructive', onPress: () => void request() },
      ],
    );
  };

  if (!api.configured) {
    return (
      <OrderPage>
        <BackHeader title="Delete account" onBack={onBack} />
        <Empty icon="cloud-off-outline" title="Not connected to DASH" body="This build has no DASH API address, so it cannot reach the account it would delete." />
      </OrderPage>
    );
  }
  if (auth.state !== 'authenticated') {
    return (
      <OrderPage>
        <BackHeader title="Delete account" onBack={onBack} />
        <Empty icon="account-lock-outline" title="Sign in first" body="Deleting an account needs you signed in to it." action="Open account" onPress={onAccount} />
      </OrderPage>
    );
  }

  const pending = deletion !== null && deletion.cancellable;

  return (
    <OrderPage testID="delete-account-v2">
      <BackHeader title="Delete account" onBack={onBack} />
      {loading ? <View style={{ minHeight: 200, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator /></View> : null}

      {!loading && pending ? (
        <>
          <Card>
            <Text variant="heading">Deletion is scheduled</Text>
            <Text variant="caption" tone="muted">
              Your account is scheduled to be deleted on {formatDate(deletion.scheduledPurgeAt)}. Until then you can still use DASH, and you can cancel below.
            </Text>
          </Card>
          <SecondaryButton label={busy ? 'Cancelling…' : 'Cancel deletion and keep my account'} onPress={() => void cancel()} disabled={busy} />
        </>
      ) : null}

      {!loading && !pending ? (
        <>
          <Card>
            <Text variant="heading">What deleting does</Text>
            <Text variant="caption" tone="muted">
              Your request schedules the account for deletion after a cooling-off period. You stay signed in and can cancel at any point before the date we show you. After that, your profile, addresses and account data are permanently removed.
            </Text>
            <Text variant="caption" tone="muted">
              Records DASH is legally required to keep — an order's financial record, for example — are kept for as long as the law requires and are no longer linked to your profile.
            </Text>
          </Card>
          <Card>
            <Text variant="label" weight="bold">Why are you leaving? (optional)</Text>
            <TextInput
              value={reason}
              onChangeText={setReason}
              placeholder="This helps us fix what went wrong."
              placeholderTextColor={palette.textSubtle}
              accessibilityLabel="Reason for deleting your account"
              multiline
              maxLength={1000}
              style={{ minHeight: 64, borderRadius: radius.md, borderWidth: 1, borderColor: palette.line, padding: space.md, color: palette.text, fontFamily: 'Manrope_400Regular', fontSize: 14 }}
            />
          </Card>
          <Notice icon="alert-circle-outline" text="An active order must finish before an account can be deleted. If you have one running, wait for it to complete." />
          <PrimaryCheckoutButton label={busy ? 'Scheduling…' : 'Delete my DASH account'} onPress={confirm} disabled={busy} busy={busy} />
        </>
      ) : null}

      {error ? <Notice icon="alert-circle-outline" text={error} danger /> : null}
    </OrderPage>
  );
}
