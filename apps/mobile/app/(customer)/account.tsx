/**
 * Profile & Settings for a customer, reached from the avatar on Home — where
 * the Customer board puts the profile, since it has no Account tab.
 *
 * Laid out like the Rider board's Profile & Settings so the two faces of one
 * account feel like one app. Who is shown comes from the session: a skeleton
 * while it is being restored (never a flash of "Guest"), the person once
 * signed in, and a way to sign in otherwise.
 *
 * "Switch to Rider" is shown only when riderModeOffered says so: in
 * production, to an approved rider only. It changes which face is shown and
 * nothing else — no sign-out, no second session.
 */

import { useRouter } from 'expo-router';
import { useRef } from 'react';
import { View } from 'react-native';

import { buildVariant } from '../../src/api';
import { useAuth } from '../../src/features/AuthProvider';
import { hrefForMode, riderModeOffered } from '../../src/features/mode';
import { useAppMode } from '../../src/features/ModeProvider';
import { viewerName } from '../../src/features/signIn';
import { space } from '../../src/theme/tokens';
import { AppBar, Avatar, Card, Divider, ListRow, Screen, Skeleton, Text } from '../../src/ui';
import { AppearanceRow } from '../../src/ui/AppearanceRow';

export default function Account() {
  const router = useRouter();
  const { setMode } = useAppMode();
  const switchingMode = useRef(false);
  const auth = useAuth();
  const offerRider = riderModeOffered(buildVariant, auth.viewer ? { riderStatus: auth.viewer.riderStatus } : null);
  const name = viewerName(auth.viewer);

  const toRider = (): void => {
    if (switchingMode.current) return;
    switchingMode.current = true;

    setMode('rider');
    router.replace(hrefForMode('rider'));
  };

  return (
    <Screen>
      <AppBar title="Profile & Settings" />
      <View style={{ paddingHorizontal: space.gutter, gap: space.lg }}>
        {auth.state === 'unauthenticated' ? (
          <Card>
            <ListRow
              icon="account-circle-outline"
              label="Sign in"
              value="Orders, wallet, addresses"
              onPress={() => router.push('/sign-in')}
            />
          </Card>
        ) : null}

        {auth.state === 'restoring' ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }} accessibilityLabel="Loading your account">
            <Skeleton style={{ width: 52, height: 52, borderRadius: 26 }} />
            <View style={{ gap: space.sm }}>
              <Skeleton style={{ width: 140, height: 18 }} />
              <Skeleton style={{ width: 190, height: 14 }} />
            </View>
          </View>
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <Avatar name={name ?? 'Guest'} size={52} />
            <View style={{ gap: 2, flex: 1 }}>
              <Text variant="heading" numberOfLines={1}>
                {auth.state === 'authenticated' ? (auth.viewer?.identity.displayName ?? name ?? 'Signed in') : 'Guest'}
              </Text>
              <Text variant="caption" tone="muted" numberOfLines={1}>
                {auth.state === 'authenticated'
                  ? (auth.viewer?.identity.email ?? auth.viewer?.identity.phone ?? 'Signed in')
                  : 'Browsing without an account'}
              </Text>
            </View>
          </View>
        )}

        <Card padded={false} style={{ paddingHorizontal: space.lg }}>
          <ListRow icon="account-outline" label="Personal Information" onPress={() => router.push('/settings/personal')} />
          <Divider />
          <ListRow icon="map-marker-outline" label="Addresses" onPress={() => router.push('/settings/addresses')} />
          <Divider />
          <ListRow icon="credit-card-outline" label="Payment Methods" onPress={() => router.push('/settings/payments')} />
          <Divider />
          <ListRow icon="bell-outline" label="Notifications" onPress={() => router.push('/settings/notifications')} />
          <Divider />
          <AppearanceRow />
          <Divider />
          <ListRow icon="translate" label="Language" value="English" onPress={() => router.push('/settings/language')} />
          <Divider />
          <ListRow icon="help-circle-outline" label="Help & Support" onPress={() => router.push('/support')} />
        </Card>

        {offerRider ? (
          <Card padded={false} style={{ paddingHorizontal: space.lg }}>
            <ListRow
              icon="moped"
              label="Switch to Rider"
              value={buildVariant === 'production' ? undefined : 'Staging'}
              onPress={toRider}
            />
          </Card>
        ) : null}

        {auth.state === 'authenticated' && auth.viewer?.phone?.number ? (
          // The server's statement about the number, in its words. Nothing in
          // V1 verifies a phone, so there is no tick and no "verified".
          <Card>
            <View style={{ gap: 2 }} testID="phone-status">
              <Text variant="label">{auth.viewer.phone.number}</Text>
              {auth.viewer.phone.notice ? (
                <Text variant="caption" tone="muted">
                  {auth.viewer.phone.notice}
                </Text>
              ) : null}
            </View>
          </Card>
        ) : null}

        {auth.state === 'authenticated' ? (
          <Card padded={false} style={{ paddingHorizontal: space.lg }}>
            <ListRow icon="logout" label="Sign out" onPress={() => void auth.signOut()} />
            <Divider />
            <ListRow icon="account-remove-outline" label="Delete account" tone="danger" onPress={() => router.push('/delete-account')} />
          </Card>
        ) : null}
      </View>
    </Screen>
  );
}
