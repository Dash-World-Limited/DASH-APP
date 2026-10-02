import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Wordmark } from '../../brand/Wordmark';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, space } from '../../theme/tokens';
import { Icon } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { LegalScreen, type LegalSlug } from '../legal/LegalScreen';
import { AccountSessionCard } from './AccountSessionCard';
import { useAppSession } from './AppSessionProvider';
import { RegisterScreen } from './RegisterScreen';

type AuthPage =
  | { name: 'welcome' }
  | { name: 'signin' }
  | { name: 'register' }
  | { name: 'legal'; slug: LegalSlug };

/**
 * The native app's front door.
 *
 * Customer/rider navigation does not mount until session restoration proves
 * who is using the device. That keeps a signed-out person out of order, wallet
 * and rider screens and avoids the demo-shell behaviour where the app used to
 * open directly on Home.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAppSession();
  const [page, setPage] = useState<AuthPage>({ name: 'welcome' });
  const { palette } = useTheme();

  if (auth.state === 'restoring') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.lg, padding: space.xl }}>
          <Wordmark />
          <ActivityIndicator color={palette.accent} />
          <Text variant="caption" tone="muted">Checking your DASH session…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (auth.state === 'authenticated') return <>{children}</>;

  if (page.name === 'register') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }}>
        <RegisterScreen
          onBack={() => setPage({ name: 'welcome' })}
          onDone={() => undefined}
          onLegal={(slug) => setPage({ name: 'legal', slug: slug as LegalSlug })}
        />
      </SafeAreaView>
    );
  }

  if (page.name === 'legal') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }}>
        <LegalScreen slug={page.slug} onBack={() => setPage({ name: 'register' })} />
      </SafeAreaView>
    );
  }

  if (page.name === 'signin') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ flexGrow: 1, padding: space.gutter, gap: space.xl }}
          showsVerticalScrollIndicator={false}
        >
          <Pressable
            onPress={() => setPage({ name: 'welcome' })}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="arrow-left" color={palette.text} />
          </Pressable>
          <View style={{ alignItems: 'center', gap: space.lg, paddingTop: space.md }}>
            <Wordmark />
            <View style={{ gap: space.xs }}>
              <Text variant="title" align="center">Welcome back</Text>
              <Text variant="caption" tone="muted" align="center">
                Sign in with the email address on your DASH account.
              </Text>
            </View>
          </View>
          <AccountSessionCard />
          <Pressable
            onPress={() => setPage({ name: 'register' })}
            accessibilityRole="button"
            accessibilityLabel="Create a DASH account"
            style={{ minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
          >
            <Text variant="caption" tone="accent" weight="bold">New to DASH? Create an account</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }}>
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'space-between', padding: space.gutter, paddingVertical: space.xxl }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ alignItems: 'center', paddingTop: space.xxl }}>
          <Wordmark />
        </View>

        <View style={{ gap: space.md, paddingVertical: space.xxxl }}>
          <Text variant="display" align="center">Everything around you, one DASH away.</Text>
          <Text variant="body" tone="muted" align="center">
            Order, track deliveries and manage your account from one secure app.
          </Text>
          {!auth.configured ? (
            <View style={{ flexDirection: 'row', gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: palette.dangerSoft }}>
              <Icon name="cloud-off-outline" color={palette.danger} />
              <Text variant="caption" style={{ flex: 1, color: palette.danger }}>
                This build is not connected to the DASH service yet.
              </Text>
            </View>
          ) : null}
        </View>

        <View style={{ gap: space.md }}>
          <AuthButton label="Sign in" onPress={() => setPage({ name: 'signin' })} />
          <AuthButton label="Create account" onPress={() => setPage({ name: 'register' })} secondary />
          <Text variant="micro" tone="muted" align="center">
            DASH uses passwordless email codes. Your phone number is collected for deliveries, not for V1 sign-in.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function AuthButton({ label, onPress, secondary = false }: { label: string; onPress: () => void; secondary?: boolean }) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        minHeight: 54,
        borderRadius: radius.md,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: secondary ? (pressed ? palette.surfaceMuted : palette.surface) : (pressed ? palette.accentPressed : palette.accent),
        borderWidth: secondary ? 1 : 0,
        borderColor: palette.line,
      })}
    >
      <Text variant="label" weight="bold" tone={secondary ? 'default' : 'onAccent'}>{label}</Text>
    </Pressable>
  );
}
