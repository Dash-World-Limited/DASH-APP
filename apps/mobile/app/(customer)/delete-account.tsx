/**
 * Delete account — in the app, as Google Play requires.
 *
 * Deletion is scheduled, not immediate: a 14-day cooling-off window, during
 * which it can be cancelled (no confirmation needed to cancel). Requesting it
 * is a step-up action: the server refuses unless this session has just
 * proved it holds the account's own email, so a code is sent there and
 * redeemed first. The same policy text is published at /delete-account on
 * the website, for people without the app.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, View } from 'react-native';

import { api } from '../../src/api';
import { ApiError } from '../../src/api/errors';
import { useAuth } from '../../src/features/AuthProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { space } from '../../src/theme/tokens';
import { AppBar, Button, Card, CodeField, EmptyState, ErrorState, Screen, Skeleton, Text } from '../../src/ui';

interface Deletion {
  status: 'scheduled' | 'held' | 'cancelled' | 'completed';
  scheduledPurgeAt: string | null;
  cancellable: boolean;
}

const describeError = (error: unknown): string =>
  error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';

/** Public page with the full policy, for anyone without the app. */
const POLICY_URL = 'https://dashworldng.com/delete-account';

export default function DeleteAccount() {
  const router = useRouter();
  const auth = useAuth();
  const { palette } = useTheme();
  const email = auth.viewer?.identity.email ?? null;

  const [deletion, setDeletion] = useState<Deletion | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stage, setStage] = useState<'explain' | 'code'>('explain');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.request<{ deletion: Deletion | null }>('/v1/account/deletion');
      setDeletion(result.deletion);
      setLoadError(null);
    } catch (error) {
      setLoadError(describeError(error));
    }
  }, []);

  useEffect(() => {
    if (auth.state === 'authenticated') void load();
  }, [auth.state, load]);

  if (auth.state !== 'authenticated') {
    return (
      <Screen>
        <AppBar title="Delete account" back />
        <EmptyState icon="account-lock-outline" title="Sign in first" body="Sign in to the account you want to delete." action="Sign in" onAction={() => router.push('/sign-in')} />
      </Screen>
    );
  }

  async function sendCode() {
    if (!email) return;
    setBusy(true);
    setNotice(null);
    try {
      await api.request('/v1/auth/otp/request', { method: 'POST', body: { email, purpose: 'step_up' } });
      setStage('code');
    } catch (error) {
      setNotice(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!email) return;
    setBusy(true);
    setNotice(null);
    try {
      await api.request('/v1/auth/otp/verify', { method: 'POST', body: { email, code, purpose: 'step_up' } });
      await api.request('/v1/account/deletion', {
        method: 'POST',
        body: {},
        headers: { 'Idempotency-Key': `app-delete-${Date.now()}` },
      });
      setStage('explain');
      await load();
    } catch (error) {
      setNotice(describeError(error));
    } finally {
      setCode('');
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    setNotice(null);
    try {
      await api.request('/v1/account/deletion', { method: 'DELETE' });
      await load();
    } catch (error) {
      setNotice(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  const scheduled = deletion && (deletion.status === 'scheduled' || deletion.status === 'held');

  return (
    <Screen testID="delete-account">
      <AppBar title="Delete account" back />
      <View style={{ paddingHorizontal: space.gutter, paddingTop: space.md, gap: space.lg }}>
        {loadError ? <ErrorState title="Could not load" message={loadError} onRetry={() => void load()} /> : null}
        {deletion === undefined && !loadError ? <Skeleton style={{ height: 140, borderRadius: 12 }} /> : null}

        {scheduled ? (
          <Card>
            <View style={{ gap: space.md }}>
              <Text variant="heading">Deletion scheduled</Text>
              <Text variant="body">
                Your account will be deleted
                {deletion?.scheduledPurgeAt ? ` on ${new Date(deletion.scheduledPurgeAt).toLocaleDateString()}` : ''}.
                {deletion?.status === 'held' ? ' It is on hold while an open dispute is resolved.' : ''}
              </Text>
              {deletion?.cancellable ? <Button variant="outline" label="Keep my account" onPress={() => void cancel()} busy={busy} /> : null}
            </View>
          </Card>
        ) : null}

        {deletion !== undefined && !scheduled && !loadError ? (
          <>
            <Card>
              <View style={{ gap: space.sm }}>
                <Text variant="heading">What happens</Text>
                <Text variant="caption">• Your account is deleted after 14 days. You can cancel before then.</Text>
                <Text variant="caption">• Deleted: sign-in sessions, devices, one-time codes and your cart.</Text>
                <Text variant="caption">• Anonymised: your name, email, phone, addresses and delivery notes.</Text>
                <Text variant="caption">
                  • Kept: order, payment and refund records with their amounts, as the law requires — no longer linked to you.
                </Text>
                <Button variant="outline" label="Read the full policy" onPress={() => void Linking.openURL(POLICY_URL)} />
              </View>
            </Card>
            {stage === 'explain' ? (
              <Button variant="inverse" label="Delete my account" onPress={() => void sendCode()} busy={busy} disabled={!email} accessibilityHint={`Sends a confirmation code to ${email ?? 'your email'}`} />
            ) : (
              <Card>
                <View style={{ gap: space.md }}>
                  <Text variant="body">Enter the code we sent to {email}.</Text>
                  <CodeField value={code} onChangeText={setCode} autoFocus />
                  <Button variant="inverse" label="Confirm deletion" onPress={() => void confirm()} busy={busy} disabled={code.length !== 6} />
                  <Button variant="outline" label="Back" onPress={() => setStage('explain')} />
                </View>
              </Card>
            )}
          </>
        ) : null}

        {notice ? (
          <Text variant="caption" style={{ color: palette.danger }} accessibilityLiveRegion="polite">
            {notice}
          </Text>
        ) : null}
      </View>
    </Screen>
  );
}
