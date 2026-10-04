/**
 * Creating a DASH account.
 *
 * The rules are src/features/register.ts's, which survived the Expo Router
 * deletion with its tests and is not reimplemented here:
 *
 * - Validation mirrors the server's, so every mistake is shown at once,
 *   before a request. The server re-checks all of it.
 * - The server answers signup identically whether or not the address already
 *   has an account, so this screen never tells anyone that it does.
 * - The phone number is stored and never verified — SMS is off in V1 — and
 *   nothing here pretends otherwise.
 * - Proving the emailed code is what signs the person in; the session is
 *   adopted at that moment, so there is no second sign-in step.
 */

import {
  ACQUISITION_SOURCES,
  ACQUISITION_SOURCE_LABELS,
  NIGERIAN_STATES,
  USAGE_INTENTS,
  USAGE_INTENT_LABELS,
  acquisitionDetailPrompt,
  type AcquisitionSource,
} from '@dash/domain/signup';
import { useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';

import { api, ApiError, session } from '../../api';
import {
  EMPTY_REGISTRATION,
  registrationProblems,
  resendVerification,
  submitRegistration,
  verifyRegistration,
  type RegistrationForm,
} from '../../features/register';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, space } from '../../theme/tokens';
import { Text } from '../../ui/Text';
import { BackHeader, Card, Empty, Notice, OrderPage, PrimaryCheckoutButton, SecondaryButton } from '../orders/parts';
import { useAppSession } from './AppSessionProvider';

const describeError = (error: unknown): string =>
  error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';

export function RegisterScreen({ onBack, onDone, onLegal }: { onBack: () => void; onDone: () => void; onLegal: (slug: string) => void }) {
  const auth = useAppSession();
  const [form, setForm] = useState<RegistrationForm>(EMPTY_REGISTRATION);
  const [showProblems, setShowProblems] = useState(false);
  const [stage, setStage] = useState<'form' | 'verify'>('form');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [resent, setResent] = useState(false);

  const problems = registrationProblems(form);
  const set = <K extends keyof RegistrationForm>(key: K, value: RegistrationForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  if (!api.configured) {
    return (
      <OrderPage>
        <BackHeader title="Create account" onBack={onBack} />
        <Empty icon="cloud-off-outline" title="Not connected to DASH" body="This build has no DASH API address, so an account cannot be created. That is a build setting (EXPO_PUBLIC_API_URL), not something to fix on the phone." />
      </OrderPage>
    );
  }

  const submit = async () => {
    setShowProblems(true);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      await submitRegistration(api, form);
      setStage('verify');
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      await verifyRegistration(api, session, form.email, code);
      await auth.restore();
      onDone();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setBusy(true);
    setError(null);
    try {
      await resendVerification(api, form.email);
      setResent(true);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  if (stage === 'verify') {
    return (
      <OrderPage testID="register-verify-v2">
        <BackHeader title="Confirm your email" onBack={() => setStage('form')} />
        <Card>
          <Text variant="heading">Enter the code we emailed</Text>
          <Text variant="caption" tone="muted">We sent a six-digit code to {form.email.trim().toLowerCase()}. Entering it confirms your address and signs you in.</Text>
          <CodeField value={code} onChange={setCode} />
          <PrimaryCheckoutButton label={busy ? 'Confirming…' : 'Confirm and continue'} onPress={() => void verify()} disabled={busy || code.length !== 6} busy={busy} />
          <SecondaryButton label={resent ? 'Code sent again' : 'Send the code again'} onPress={() => void resend()} disabled={busy} />
        </Card>
        {error ? <Notice icon="alert-circle-outline" text={error} danger /> : null}
      </OrderPage>
    );
  }

  const detailPrompt = acquisitionDetailPrompt(form.acquisitionSource as AcquisitionSource);

  return (
    <OrderPage testID="register-v2">
      <BackHeader title="Create account" onBack={onBack} />

      <Card>
        <Field label="Full name" value={form.fullName} onChange={(value) => set('fullName', value)} placeholder="Adaeze Okonkwo" autoCapitalize="words" problem={showProblems ? problems.fullName : undefined} />
        <Field label="Email" value={form.email} onChange={(value) => set('email', value)} placeholder="you@example.com" keyboard="email-address" autoCapitalize="none" problem={showProblems ? problems.email : undefined} />
        <Field label="Phone" value={form.phone} onChange={(value) => set('phone', value)} placeholder="+234 801 234 5678" keyboard="phone-pad" problem={showProblems ? problems.phone : undefined} />
        <Text variant="micro" tone="muted">Your phone number is stored for deliveries. DASH does not send verification texts.</Text>
      </Card>

      <Card>
        <Text variant="label" weight="bold">Where you are</Text>
        <Chips
          label="State"
          options={NIGERIAN_STATES.map((state) => ({ value: state, label: state }))}
          selected={form.state}
          onSelect={(value) => set('state', value)}
          problem={showProblems ? problems.state : undefined}
        />
        <Field label="City, town or area" value={form.cityArea} onChange={(value) => set('cityArea', value)} placeholder="Lekki" problem={showProblems ? problems.cityArea : undefined} />
      </Card>

      <Card>
        <Text variant="label" weight="bold">How you plan to use DASH</Text>
        <Chips
          options={USAGE_INTENTS.map((intent) => ({ value: intent, label: USAGE_INTENT_LABELS[intent] }))}
          selected={form.usageIntent}
          onSelect={(value) => set('usageIntent', value)}
          problem={showProblems ? problems.usageIntent : undefined}
        />
      </Card>

      <Card>
        <Text variant="label" weight="bold">How did you hear about DASH?</Text>
        <Chips
          options={ACQUISITION_SOURCES.map((source) => ({ value: source, label: ACQUISITION_SOURCE_LABELS[source] }))}
          selected={form.acquisitionSource}
          onSelect={(value) => set('acquisitionSource', value)}
          problem={showProblems ? problems.acquisitionSource : undefined}
        />
        {detailPrompt ? (
          <Field label={detailPrompt} value={form.acquisitionDetail} onChange={(value) => set('acquisitionDetail', value)} placeholder="" problem={showProblems ? problems.acquisitionDetail : undefined} />
        ) : null}
      </Card>

      <Card>
        <Check
          checked={form.confirmedAdult}
          onToggle={() => set('confirmedAdult', !form.confirmedAdult)}
          label="I am 18 or older"
          problem={showProblems ? problems.confirmedAdult : undefined}
        />
        <Check
          checked={form.acceptedTerms}
          onToggle={() => set('acceptedTerms', !form.acceptedTerms)}
          label="I accept the DASH Terms of Service and Privacy Policy"
          problem={showProblems ? problems.acceptedTerms : undefined}
        />
        <View style={{ flexDirection: 'row', gap: space.md }}>
          <View style={{ flex: 1 }}><SecondaryButton label="Read Terms" onPress={() => onLegal('terms-of-service')} /></View>
          <View style={{ flex: 1 }}><SecondaryButton label="Read Privacy" onPress={() => onLegal('privacy-policy')} /></View>
        </View>
        <Check
          checked={form.marketingOptIn}
          onToggle={() => set('marketingOptIn', !form.marketingOptIn)}
          label="Send me DASH offers and updates (optional)"
        />
      </Card>

      {error ? <Notice icon="alert-circle-outline" text={error} danger /> : null}
      <PrimaryCheckoutButton label={busy ? 'Creating your account…' : 'Create account'} onPress={() => void submit()} disabled={busy} busy={busy} />
    </OrderPage>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  keyboard = 'default',
  autoCapitalize = 'sentences',
  problem,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  keyboard?: 'default' | 'email-address' | 'phone-pad';
  autoCapitalize?: 'none' | 'words' | 'sentences';
  problem?: string;
}) {
  const { palette } = useTheme();
  return (
    <View style={{ gap: space.xs }}>
      <Text variant="micro" tone="muted">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={palette.textSubtle}
        keyboardType={keyboard}
        autoCapitalize={autoCapitalize}
        accessibilityLabel={label}
        style={{ minHeight: 48, borderRadius: radius.md, borderWidth: 1, borderColor: problem ? palette.danger : palette.line, backgroundColor: palette.background, paddingHorizontal: space.md, color: palette.text, fontFamily: 'Manrope_500Medium', fontSize: 15 }}
      />
      {problem ? <Text variant="micro" style={{ color: palette.danger }}>{problem}</Text> : null}
    </View>
  );
}

/** A horizontal set of choices. Long sets (the 37 states) scroll. */
function Chips({
  label,
  options,
  selected,
  onSelect,
  problem,
}: {
  label?: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  selected: string;
  onSelect: (value: string) => void;
  problem?: string;
}) {
  const { palette } = useTheme();
  const chip = (option: { value: string; label: string }) => {
    const active = option.value === selected;
    return (
      <Pressable
        key={option.value}
        onPress={() => onSelect(option.value)}
        accessibilityRole="radio"
        accessibilityState={{ selected: active }}
        accessibilityLabel={option.label}
        style={{ minHeight: 42, justifyContent: 'center', paddingHorizontal: space.lg, borderRadius: radius.pill, backgroundColor: active ? palette.inverse : palette.surface, borderWidth: 1, borderColor: active ? palette.inverse : palette.line }}
      >
        <Text variant="caption" weight="bold" tone={active ? 'onInverse' : 'default'}>{option.label}</Text>
      </Pressable>
    );
  };
  return (
    <View style={{ gap: space.xs }}>
      {label ? <Text variant="micro" tone="muted">{label}</Text> : null}
      {options.length > 8 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, paddingVertical: 2 }} accessibilityRole="radiogroup">
          {options.map(chip)}
        </ScrollView>
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }} accessibilityRole="radiogroup">{options.map(chip)}</View>
      )}
      {problem ? <Text variant="micro" style={{ color: palette.danger }}>{problem}</Text> : null}
    </View>
  );
}

function Check({ checked, onToggle, label, problem }: { checked: boolean; onToggle: () => void; label: string; problem?: string }) {
  const { palette } = useTheme();
  return (
    <View style={{ gap: space.xs }}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        accessibilityLabel={label}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 44 }}
      >
        <View style={{ width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: checked ? palette.accent : problem ? palette.danger : palette.line, backgroundColor: checked ? palette.accent : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
          {checked ? <Text variant="micro" tone="onAccent" weight="bold">✓</Text> : null}
        </View>
        <Text variant="caption" style={{ flex: 1 }}>{label}</Text>
      </Pressable>
      {problem ? <Text variant="micro" style={{ color: palette.danger }}>{problem}</Text> : null}
    </View>
  );
}

function CodeField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { palette } = useTheme();
  return (
    <TextInput
      value={value}
      onChangeText={(next) => onChange(next.replace(/\D/g, '').slice(0, 6))}
      keyboardType="number-pad"
      maxLength={6}
      placeholder="000000"
      placeholderTextColor={palette.textSubtle}
      accessibilityLabel="Six digit confirmation code"
      style={{ minHeight: 58, borderRadius: radius.md, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.background, color: palette.text, textAlign: 'center', fontSize: 24, letterSpacing: 8, fontFamily: 'Manrope_700Bold' }}
    />
  );
}
