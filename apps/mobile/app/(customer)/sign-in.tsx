/**
 * Sign in with a code sent to your email.
 *
 * Two steps on one screen: the address, then the six digits. Everything that
 * decides whether a code is valid lives on the server; this screen checks
 * what is typed, counts down to "send a new code" using the server's own
 * timing, and says plainly what went wrong.
 *
 * It never confirms that an account exists: the server answers every address
 * the same way, and so does this screen ("if an account uses this address").
 * Inside the Customer face's stack, so finishing returns to where it opened.
 */

import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';

import { buildVariant } from '../../src/api';
import { useAuth } from '../../src/features/AuthProvider';
import {
  classifySignInError,
  CODE_LENGTH,
  emailProblem,
  formatCountdown,
  maskEmail,
  type SignInErrorKind,
} from '../../src/features/signIn';
import { useTheme } from '../../src/theme/ThemeProvider';
import { radius, space } from '../../src/theme/tokens';
import { AppBar, Button, CodeField, Icon, Screen, Text, TextField } from '../../src/ui';

type Step = 'email' | 'code';

export default function SignIn() {
  const router = useRouter();
  const auth = useAuth();

  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ kind: SignInErrorKind; message: string } | null>(null);
  const [expiresIn, setExpiresIn] = useState(300);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const verifying = useRef(false);

  // One tick a second while a countdown is showing.
  useEffect(() => {
    if (step !== 'code') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [step]);

  const leave = (): void => (router.canGoBack() ? router.back() : router.replace('/account'));

  const send = async (): Promise<void> => {
    const invalid = emailProblem(email);
    setEmailError(invalid);
    if (invalid || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const sent = await auth.requestCode(email);
      setExpiresIn(sent.expiresInSeconds);
      setResendAt(Date.now() + sent.resendAfterSeconds * 1000);
      setNow(Date.now());
      setCode('');
      setStep('code');
    } catch (error) {
      setProblem(classifySignInError(error));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (digits: string): Promise<void> => {
    if (verifying.current || digits.length !== CODE_LENGTH) return;
    verifying.current = true;
    setBusy(true);
    setProblem(null);
    try {
      await auth.verifyCode(email, digits);
      leave();
    } catch (error) {
      const classified = classifySignInError(error);
      setProblem(classified);
      setCode('');
    } finally {
      verifying.current = false;
      setBusy(false);
    }
  };

  const onCode = (digits: string): void => {
    setCode(digits);
    if (problem?.kind === 'wrong_or_expired') setProblem(null);
    if (digits.length === CODE_LENGTH) void verify(digits);
  };

  const secondsToResend = Math.max(0, (resendAt - now) / 1000);
  const canResend = secondsToResend <= 0 || problem?.kind === 'too_many';

  return (
    <Screen testID="sign-in">
      <AppBar title={step === 'email' ? 'Sign in' : 'Enter your code'} onBack={step === 'code' ? () => setStep('email') : undefined} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ paddingHorizontal: space.gutter, paddingTop: space.md, gap: space.xl }}>
          {step === 'email' ? (
            <>
              <View style={{ gap: space.sm }}>
                <Text variant="title" accessibilityRole="header">
                  Sign in to DASH
                </Text>
                <Text variant="body" tone="muted">
                  Enter the email address on your DASH account and we will send you a 6-digit code. No password to remember.
                </Text>
              </View>

              {!auth.configured ? (
                <Notice
                  icon="cloud-off-outline"
                  title="This build is not connected to a DASH server"
                  body="Sign-in works in builds pointed at the DASH API. Browsing, the cart and the Rider screens still work here with staging data."
                />
              ) : null}

              <TextField
                label="Email address"
                value={email}
                onChangeText={(text) => {
                  setEmail(text);
                  if (emailError) setEmailError(null);
                }}
                placeholder="you@example.com"
                keyboardType="email-address"
                autoComplete="email"
                textContentType="emailAddress"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="send"
                onSubmitEditing={() => void send()}
                error={emailError}
                editable={!busy}
                testID="sign-in-email"
              />

              {problem ? <Notice icon="alert-circle-outline" title={problem.message} tone="danger" /> : null}

              <Button
                label="Send code"
                onPress={() => void send()}
                busy={busy}
                disabled={!auth.configured}
                testID="sign-in-send"
              />

              {buildVariant !== 'production' ? (
                <Text variant="caption" tone="muted">
                  Test build: while DASH email is in its test period, codes reach only addresses approved for testing.
                </Text>
              ) : null}
            </>
          ) : (
            <>
              <View style={{ gap: space.sm }}>
                <Text variant="title" accessibilityRole="header">
                  Check your email
                </Text>
                <Text variant="body" tone="muted">
                  If an account uses {maskEmail(email)}, a {CODE_LENGTH}-digit code is on its way. It works for{' '}
                  {Math.round(expiresIn / 60)} minutes.
                </Text>
                <Pressable onPress={() => setStep('email')} accessibilityRole="link" hitSlop={8} style={{ alignSelf: 'flex-start' }}>
                  <Text variant="label" tone="accent">
                    Use a different address
                  </Text>
                </Pressable>
              </View>

              <CodeField value={code} onChangeText={onCode} error={problem?.kind === 'wrong_or_expired'} editable={!busy} testID="sign-in-code" />

              {busy ? (
                <Text variant="label" tone="muted" align="center">
                  Checking your code…
                </Text>
              ) : problem ? (
                <Notice icon="alert-circle-outline" title={problem.message} tone="danger" />
              ) : null}

              <View style={{ alignItems: 'center' }}>
                {canResend ? (
                  <Pressable onPress={() => void send()} accessibilityRole="button" hitSlop={10} disabled={busy}>
                    <Text variant="label" tone="accent">
                      Send a new code
                    </Text>
                  </Pressable>
                ) : (
                  <Text variant="caption" tone="muted" accessibilityLiveRegion="polite">
                    You can ask for a new code in {formatCountdown(secondsToResend)}
                  </Text>
                )}
              </View>

              <Text variant="caption" tone="muted" align="center">
                Not there? Check spam or promotions. Codes only ever come from DASH, and nobody at DASH will ask you for one.
              </Text>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );

}

function Notice({
  icon,
  title,
  body,
  tone,
}: {
  icon: 'cloud-off-outline' | 'alert-circle-outline';
  title: string;
  body?: string;
  tone?: 'danger';
}) {
  const { palette } = useTheme();
  const color = tone === 'danger' ? palette.danger : palette.textMuted;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: 'row',
        gap: space.md,
        padding: space.md,
        borderRadius: radius.md,
        backgroundColor: tone === 'danger' ? palette.dangerSoft : palette.sand,
      }}
    >
      <Icon name={icon} size={20} color={color} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="label" style={tone === 'danger' ? { color: palette.danger } : undefined}>
          {title}
        </Text>
        {body ? (
          <Text variant="caption" tone="muted">
            {body}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
