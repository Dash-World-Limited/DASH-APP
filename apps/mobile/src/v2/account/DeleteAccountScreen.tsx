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
 *
 * Deleting is a step-up action: the server refuses it unless the session
 * proved, in the last fifteen minutes, that it holds this account's email.
 * So the flow emails a code to the account's own address, redeems it, and
 * only then posts the deletion — in the same handler, with one idempotency
 * key per attempt, reused on retry and cleared only on success.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, TextInput, View } from 'react-native';

import { api, ApiError } from '../../api';
import { newIdempotencyKey } from '../../data/orders';
import { CODE_LENGTH, codeDigits, formatCountdown, maskEmail } from '../../features/signIn';
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

const codeInputStyle = (palette: { line: string; text: string }) => ({
  borderRadius: radius.md,
  borderWidth: 1,
  borderColor: palette.line,
  padding: space.md,
  color: palette.text,
  fontFamily: 'Manrope_400Regular',
  fontSize: 16,
  letterSpacing: 4,
});

export function DeleteAccountScreen({ onBack, onAccount }: { onBack: () => void; onAccount: () => void }) {
  const { palette } = useTheme();
  const auth = useAppSession();
  const [deletion, setDeletion] = useState<Deletion | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [stage, setStage] = useState<'idle' | 'code_sent'>('idle');
  const [code, setCode] = useState('');
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [codeSentAt, setCodeSentAt] = useState<number | null>(null);
  const [codeTtl, setCodeTtl] = useState({ expiresInSeconds: 300, resendAfterSeconds: 60 });
  // Re-render once a second while a code is live, so the expiry countdown and
  // the resend cooldown update without any other interaction.
  const [, setTick] = useState(0);
  // Keep retries of one request idempotent if the response is lost.
  const attemptKey = useRef<string | null>(null);
  // Synchronous double-tap guard: state updates land after a re-render.
  const inFlight = useRef(false);

  const email = auth.viewer?.identity.email ?? null;

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

  useEffect(() => {
    if (stage !== 'code_sent') return;
    const id = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(id);
  }, [stage]);

  const sendCode = async () => {
    if (!email) {
      setError('We need the email on your account to send a code. Please sign in again.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.request<{ expiresInSeconds?: unknown; resendAfterSeconds?: unknown }>(
        '/v1/auth/otp/request',
        { method: 'POST', body: { email, purpose: 'step_up' } },
      );
      setCodeTtl({
        expiresInSeconds: typeof result.expiresInSeconds === 'number' ? result.expiresInSeconds : 300,
        resendAfterSeconds: typeof result.resendAfterSeconds === 'number' ? result.resendAfterSeconds : 60,
      });
      setCodeSentAt(Date.now());
      setCode('');
      setCodeSentTo(maskEmail(email));
      setStage('code_sent');
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const postDeletion = async () => {
    attemptKey.current ??= newIdempotencyKey();
    const result = await api.request<{ deletion: Deletion }>('/v1/account/deletion', {
      method: 'POST',
      headers: { 'Idempotency-Key': attemptKey.current },
      body: reason.trim() ? { reason: reason.trim() } : {},
    });
    attemptKey.current = null;
    setReason('');
    setStage('idle');
    setDeletion(result.deletion);
    await load();
  };

  const confirmAndDelete = async () => {
    if (inFlight.current) return;
    if (!email) {
      setError('We need the email on your account to send a code. Please sign in again.');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.request('/v1/auth/otp/verify', {
        method: 'POST',
        body: { email, code: codeDigits(code), purpose: 'step_up' },
      });
      // Immediately, in the same handler: the step-up is valid 15 minutes
      // from verification, and lingering here would waste it.
      await postDeletion();
    } catch (caught) {
      if (caught instanceof ApiError && (caught.code === 'step_up_required' || caught.code === 'step_up_expired')) {
        // The step-up did not stick: back to the code stage with the same
        // attempt key, so the next POST is a retry of the same request.
        setError('Confirm it is you — enter the fresh code we emailed.');
        setStage('code_sent');
      } else if (caught instanceof ApiError && caught.status === 409) {
        setError('That request is already being processed — please wait a moment.');
      } else {
        setError(describeError(caught));
      }
    } finally {
      // The code is single-use: clear it after every attempt, as the web does.
      setCode('');
      setBusy(false);
      inFlight.current = false;
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
        { text: 'Schedule deletion', style: 'destructive', onPress: () => void sendCode() },
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
  const held = pending && deletion.status === 'held';
  const now = Date.now();
  const resendReady = codeSentAt !== null && now >= codeSentAt + codeTtl.resendAfterSeconds * 1000;
  const resendWaitSeconds = codeSentAt === null ? codeTtl.resendAfterSeconds : Math.max(0, Math.ceil(codeTtl.resendAfterSeconds - (now - codeSentAt) / 1000));
  const codeExpiresInSeconds = codeSentAt === null ? codeTtl.expiresInSeconds : Math.max(0, codeTtl.expiresInSeconds - Math.floor((now - codeSentAt) / 1000));

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
            {held ? (
              <Text variant="caption" tone="muted">
                It is on hold while an open dispute is resolved.
              </Text>
            ) : null}
          </Card>
          {deletion.cancellable ? (
            <SecondaryButton label={busy ? 'Cancelling…' : 'Cancel deletion and keep my account'} onPress={() => void cancel()} disabled={busy} />
          ) : null}
        </>
      ) : null}

      {!loading && !pending && stage === 'idle' ? (
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

      {!loading && !pending && stage === 'code_sent' ? (
        <>
          <Card>
            <Text variant="heading">Check your email</Text>
            <Text variant="caption" tone="muted">
              Code sent to {codeSentTo ?? 'your email'}. It expires in {formatCountdown(codeExpiresInSeconds)}.
            </Text>
            <TextInput
              value={code}
              onChangeText={(value) => setCode(codeDigits(value))}
              placeholder="6-digit code"
              placeholderTextColor={palette.textSubtle}
              accessibilityLabel="Deletion confirmation code"
              keyboardType="number-pad"
              autoComplete="one-time-code"
              maxLength={CODE_LENGTH}
              style={codeInputStyle(palette)}
            />
          </Card>
          <SecondaryButton label="Back" onPress={() => { setStage('idle'); setCode(''); }} disabled={busy} />
          <SecondaryButton
            label={resendReady ? 'Resend code' : `Resend code in ${formatCountdown(resendWaitSeconds)}`}
            onPress={() => void sendCode()}
            disabled={busy || !resendReady}
          />
          <PrimaryCheckoutButton label={busy ? 'Confirming…' : 'Confirm deletion'} onPress={() => void confirmAndDelete()} disabled={busy || code.length !== CODE_LENGTH} busy={busy} />
        </>
      ) : null}

      {error ? <Notice icon="alert-circle-outline" text={error} danger /> : null}
    </OrderPage>
  );
}
