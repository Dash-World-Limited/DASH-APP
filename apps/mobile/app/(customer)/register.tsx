/**
 * Create an account — then prove the email with a six-digit code.
 *
 * Proving the address signs the person in, so there is no second sign-in
 * step. The phone number is stored unverified (SMS is off in V1) and the
 * screen says so in the same words as everywhere else. The server answers the
 * form identically whether or not the email already has an account, and so
 * does this screen: "check your email" either way.
 *
 * Every mistake is shown at once, before anything is sent.
 */

import { ACQUISITION_SOURCE_LABELS, ACQUISITION_SOURCES, acquisitionDetailPrompt, NIGERIAN_STATES, USAGE_INTENT_LABELS, USAGE_INTENTS, type AcquisitionSource } from '@dash/domain/signup';
import { PHONE_UNVERIFIED_NOTICE } from '@dash/domain/onboarding';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { api } from '../../src/api';
import { ApiError } from '../../src/api/errors';
import { useAuth } from '../../src/features/AuthProvider';
import { EMPTY_REGISTRATION, registrationProblems, resendVerification, submitRegistration, type RegistrationField, type RegistrationForm } from '../../src/features/register';
import { maskEmail } from '../../src/features/signIn';
import { useTheme } from '../../src/theme/ThemeProvider';
import { space } from '../../src/theme/tokens';
import { AppBar, Button, Card, Chip, CodeField, EmptyState, Screen, Text, TextField, Toggle } from '../../src/ui';

const describeError = (error: unknown): string =>
  error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';

export default function Register() {
  const router = useRouter();
  const auth = useAuth();
  const { palette } = useTheme();
  const [form, setForm] = useState<RegistrationForm>(EMPTY_REGISTRATION);
  const [showProblems, setShowProblems] = useState(false);
  const [stage, setStage] = useState<'form' | 'code'>('form');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState('');

  const problems = useMemo(() => registrationProblems(form), [form]);
  const problem = (field: RegistrationField): string | null => (showProblems ? (problems[field] ?? null) : null);
  const set = <K extends RegistrationField>(field: K, value: RegistrationForm[K]) => setForm((current) => ({ ...current, [field]: value }));

  if (!auth.configured) {
    return (
      <Screen>
        <AppBar title="Create account" back />
        <EmptyState icon="cloud-off-outline" title="Not connected" body="This build is not connected to a DASH server, so accounts cannot be created in it." />
      </Screen>
    );
  }

  async function submit() {
    setShowProblems(true);
    if (Object.keys(problems).length > 0) {
      setNotice('Check the fields marked below.');
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await submitRegistration(api, form);
      setStage('code');
    } catch (error) {
      setNotice(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setNotice(null);
    try {
      await auth.completeRegistration(form.email, code);
      router.replace('/account');
    } catch (error) {
      setNotice(describeError(error));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setBusy(true);
    setNotice(null);
    try {
      await resendVerification(api, form.email);
      setNotice('If that address is waiting for a code, a new one is on its way. The earlier code no longer works.');
    } catch (error) {
      setNotice(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  if (stage === 'code') {
    return (
      <Screen>
        <AppBar title="Verify your email" back onBack={() => setStage('form')} />
        <View style={{ paddingHorizontal: space.gutter, paddingTop: space.lg, gap: space.lg }}>
          <Text variant="body">
            Check your email. If {maskEmail(form.email)} can be registered, we sent a 6-digit code to it. It expires in a few minutes.
          </Text>
          <CodeField value={code} onChangeText={setCode} autoFocus testID="register-code" />
          <Button label="Verify and continue" onPress={() => void verify()} disabled={code.length !== 6} busy={busy} />
          <Button variant="outline" label="Send a new code" onPress={() => void resend()} disabled={busy} />
          <Text variant="caption" tone="muted">
            Already have an account with this email? Sign in instead — nothing was changed.
          </Text>
          {notice ? (
            <Text variant="caption" style={{ color: palette.textMuted }} accessibilityLiveRegion="polite">
              {notice}
            </Text>
          ) : null}
        </View>
      </Screen>
    );
  }

  const detailPrompt = form.acquisitionSource ? acquisitionDetailPrompt(form.acquisitionSource as AcquisitionSource) : null;
  const states = NIGERIAN_STATES.filter((state) => state.toLowerCase().includes(stateFilter.trim().toLowerCase()));

  return (
    <Screen testID="register">
      <AppBar title="Create account" back />
      <View style={{ paddingHorizontal: space.gutter, paddingTop: space.md, gap: space.lg }}>
        <TextField label="Full name" value={form.fullName} onChangeText={(v) => set('fullName', v)} autoComplete="name" maxLength={80} error={problem('fullName')} />
        <TextField label="Email" value={form.email} onChangeText={(v) => set('email', v)} keyboardType="email-address" autoCapitalize="none" autoComplete="email" error={problem('email')} hint="We send a code here to confirm it is yours." />
        <TextField label="Phone" value={form.phone} onChangeText={(v) => set('phone', v)} keyboardType="phone-pad" autoComplete="tel" error={problem('phone')} hint={PHONE_UNVERIFIED_NOTICE} />

        <View style={{ gap: space.sm }}>
          <Text variant="label">State</Text>
          <TextField label="Search states" value={stateFilter} onChangeText={setStateFilter} placeholder="e.g. Lagos" />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }} accessibilityRole="radiogroup">
            {states.map((state) => (
              <Chip key={state} label={state} selected={form.state === state} onPress={() => set('state', state)} />
            ))}
          </View>
          {problem('state') ? <Text variant="caption" style={{ color: palette.danger }}>{problem('state')}</Text> : null}
        </View>

        <TextField label="City, town or area" value={form.cityArea} onChangeText={(v) => set('cityArea', v)} maxLength={80} error={problem('cityArea')} />

        <View style={{ gap: space.sm }}>
          <Text variant="label">How do you plan to use DASH?</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }} accessibilityRole="radiogroup">
            {USAGE_INTENTS.map((intent) => (
              <Chip key={intent} label={USAGE_INTENT_LABELS[intent]} selected={form.usageIntent === intent} onPress={() => set('usageIntent', intent)} />
            ))}
          </View>
        </View>

        <View style={{ gap: space.sm }}>
          <Text variant="label">How did you hear about DASH?</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }} accessibilityRole="radiogroup">
            {ACQUISITION_SOURCES.map((source) => (
              <Chip key={source} label={ACQUISITION_SOURCE_LABELS[source]} selected={form.acquisitionSource === source} onPress={() => set('acquisitionSource', source)} />
            ))}
          </View>
          {problem('acquisitionSource') ? <Text variant="caption" style={{ color: palette.danger }}>{problem('acquisitionSource')}</Text> : null}
          {detailPrompt ? (
            <TextField label={detailPrompt} value={form.acquisitionDetail} onChangeText={(v) => set('acquisitionDetail', v)} maxLength={120} error={problem('acquisitionDetail')} />
          ) : null}
        </View>

        <Card>
          <View style={{ gap: space.md }}>
            <Toggle label="I am 18 or older" value={form.confirmedAdult} onValueChange={(v) => set('confirmedAdult', v)} />
            {problem('confirmedAdult') ? <Text variant="caption" style={{ color: palette.danger }}>{problem('confirmedAdult')}</Text> : null}
            <Toggle label="I accept the Terms of Service and Privacy Policy" value={form.acceptedTerms} onValueChange={(v) => set('acceptedTerms', v)} />
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              <Button variant="outline" label="Terms" onPress={() => router.push('/legal/terms-of-service')} style={{ flex: 1 }} />
              <Button variant="outline" label="Privacy" onPress={() => router.push('/legal/privacy-policy')} style={{ flex: 1 }} />
            </View>
            {problem('acceptedTerms') ? <Text variant="caption" style={{ color: palette.danger }}>{problem('acceptedTerms')}</Text> : null}
            <Toggle label="Send me offers and news (optional)" value={form.marketingOptIn} onValueChange={(v) => set('marketingOptIn', v)} />
          </View>
        </Card>

        {notice ? (
          <Text variant="caption" style={{ color: palette.danger }} accessibilityLiveRegion="polite">
            {notice}
          </Text>
        ) : null}
        <Button label="Create account" onPress={() => void submit()} busy={busy} testID="register-submit" />
        <Button variant="outline" label="I already have an account" onPress={() => router.replace('/sign-in')} />
        <View style={{ height: space.xl }} />
      </View>
    </Screen>
  );
}
