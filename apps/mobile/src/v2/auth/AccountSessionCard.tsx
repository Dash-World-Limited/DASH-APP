import { useState } from 'react';
import { ActivityIndicator, Pressable, TextInput, View } from 'react-native';

import { useTheme } from '../../theme/ThemeProvider';
import { radius, space } from '../../theme/tokens';
import { Icon } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useAppSession } from './AppSessionProvider';

export function AccountSessionCard() {
  const { palette } = useTheme();
  const auth = useAppSession();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);

  if (auth.state === 'authenticated' && auth.viewer) {
    return (
      <View style={{ gap: space.md, padding: space.lg, borderRadius: radius.lg, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line }}>
        <View style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}>
          <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: palette.inverse, alignItems: 'center', justifyContent: 'center' }}><Icon name="account-check-outline" color={palette.textOnInverse} /></View>
          <View style={{ flex: 1 }}><Text variant="label" weight="bold">{auth.viewer.identity.displayName ?? 'DASH member'}</Text><Text variant="caption" tone="muted">{auth.viewer.identity.email ?? auth.viewer.identity.phone ?? 'Signed in'}</Text></View>
        </View>
        <Text variant="micro" tone="muted">Roles: {auth.viewer.roles.join(', ') || 'customer'}</Text>
        <Button label={auth.busy ? 'Signing out…' : 'Sign out'} onPress={() => void auth.signOut()} disabled={auth.busy} secondary />
      </View>
    );
  }

  if (!auth.configured) {
    return (
      <View style={{ gap: space.sm, padding: space.lg, borderRadius: radius.lg, backgroundColor: palette.dangerSoft }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}><Icon name="server-network-off" color={palette.danger} /><Text variant="label" weight="bold">DASH service unavailable</Text></View>
        <Text variant="caption">This app build has no usable DASH API address. Install a connected build before signing in.</Text>
      </View>
    );
  }

  if (auth.state === 'restoring') {
    return <View style={{ minHeight: 120, alignItems: 'center', justifyContent: 'center', gap: space.sm }}><ActivityIndicator color={palette.accent} /><Text variant="caption" tone="muted">Restoring your secure session…</Text></View>;
  }

  const destination = { email: email.trim().toLowerCase() };

  return (
    <View style={{ gap: space.md, padding: space.lg, borderRadius: radius.lg, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line }}>
      <View>
        <Text variant="heading">Sign in to DASH</Text>
        <Text variant="caption" tone="muted">We’ll email you a one-time six-digit code. No password.</Text>
      </View>

      {!sent ? (
        <>
          <TextInput
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            placeholder="you@example.com"
            placeholderTextColor={palette.textSubtle}
            accessibilityLabel="Email address"
            style={{ minHeight: 52, borderRadius: radius.md, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.background, color: palette.text, paddingHorizontal: space.md, fontFamily: 'Manrope_500Medium' }}
          />
          <Button
            label={auth.busy ? 'Sending…' : 'Send code'}
            disabled={auth.busy || !email.includes('@')}
            onPress={() => void auth.requestOtp(destination).then((result) => {
              if (result) {
                setSent(true);
                setDevCode(result.devCode ?? null);
              }
            })}
          />
        </>
      ) : (
        <>
          <Text variant="caption" tone="muted">Enter the code sent to {email.trim().toLowerCase()}.</Text>
          {devCode ? <View style={{ padding: space.sm, borderRadius: radius.sm, backgroundColor: palette.successSoft }}><Text variant="caption" style={{ color: palette.success }}>Development code: {devCode}</Text></View> : null}
          <TextInput
            value={code}
            onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 6))}
            keyboardType="number-pad"
            maxLength={6}
            placeholder="000000"
            placeholderTextColor={palette.textSubtle}
            accessibilityLabel="Six digit sign-in code"
            style={{ minHeight: 58, borderRadius: radius.md, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.background, color: palette.text, textAlign: 'center', fontSize: 24, letterSpacing: 8, fontFamily: 'Manrope_700Bold' }}
          />
          <Button label={auth.busy ? 'Verifying…' : 'Verify and sign in'} disabled={auth.busy || code.length !== 6} onPress={() => void auth.verifyOtp(destination, code)} />
          <Button label="Use a different email" secondary onPress={() => { setSent(false); setCode(''); setDevCode(null); auth.clearError(); }} />
        </>
      )}

      {auth.error ? <View style={{ flexDirection: 'row', gap: space.sm, padding: space.sm, borderRadius: radius.sm, backgroundColor: palette.dangerSoft }}><Icon name="alert-circle-outline" color={palette.danger} /><Text variant="caption" style={{ flex: 1, color: palette.danger }}>{auth.error}</Text></View> : null}
    </View>
  );
}

function Button({ label, onPress, disabled = false, secondary = false }: { label: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) {
  const { palette } = useTheme();
  return <Pressable disabled={disabled} onPress={onPress} accessibilityRole="button" accessibilityState={{ disabled }} style={({ pressed }) => ({ minHeight: 50, borderRadius: radius.md, opacity: disabled ? 0.5 : 1, alignItems: 'center', justifyContent: 'center', backgroundColor: secondary ? (pressed ? palette.surfaceMuted : palette.surface) : (pressed ? palette.accentPressed : palette.accent), borderWidth: secondary ? 1 : 0, borderColor: palette.line })}><Text variant="label" weight="bold" tone={secondary ? 'default' : 'onAccent'}>{label}</Text></Pressable>;
}
