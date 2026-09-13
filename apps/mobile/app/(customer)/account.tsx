/**
 * Profile & Settings for a customer, reached from the avatar on Home — where
 * the Customer board puts the profile, since it has no Account tab.
 *
 * Laid out like the Rider board's Profile & Settings so the two faces of one
 * account feel like one app. Sign-in arrives with checkout, so this build
 * shows a guest and says how that changes.
 *
 * "Switch to Rider" is shown only when `riderModeOffered` says so: in
 * production, to an approved rider only. It changes which face is shown and
 * nothing else — no sign-out, no second session.
 */

import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { buildVariant } from '../../src/api';
import { riderModeOffered } from '../../src/features/mode';
import { useAppMode } from '../../src/features/ModeProvider';
import { space } from '../../src/theme/tokens';
import { AppBar, Avatar, Card, Divider, ListRow, Screen, Text } from '../../src/ui';
import { AppearanceRow } from '../../src/ui/AppearanceRow';

export default function Account() {
  const router = useRouter();
  const { setMode } = useAppMode();
  const offerRider = riderModeOffered(buildVariant, null);

  return (
    <Screen>
      <AppBar title="Profile & Settings" />
      <View style={{ paddingHorizontal: space.gutter, gap: space.lg }}>
        <Card>
          <ListRow
            icon="account-circle-outline"
            label="Sign in"
            value="Orders, wallet, addresses"
            onPress={() => router.push('/settings/sign-in')}
          />
        </Card>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Avatar name="Guest" size={52} />
          <View style={{ gap: 2 }}>
            <Text variant="heading">Guest</Text>
            <Text variant="caption" tone="muted">
              Browsing without an account
            </Text>
          </View>
        </View>

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
              onPress={() => {
                setMode('rider');
                router.replace('/rider');
              }}
            />
          </Card>
        ) : null}
      </View>
    </Screen>
  );
}
