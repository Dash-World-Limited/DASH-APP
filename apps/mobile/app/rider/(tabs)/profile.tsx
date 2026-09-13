/**
 * Profile & Settings — the Rider board, screen 10.
 *
 * The rider's identity, the documents DASH reviewed, where earnings are paid,
 * notifications, Appearance and language — and the switch back to the
 * Customer face of the same account.
 *
 * STAGING DATA: the name, rating and "Verified" status are the board's. Wired,
 * "Verified" is the server's rider approval status and nothing else.
 */

import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { api } from '../../../src/api';
import { SampleDataNote } from '../../../src/commerce/Promotions';
import { RIDER_PROFILE } from '../../../src/data/staging';
import { useAppMode } from '../../../src/features/ModeProvider';
import { useRiderShift } from '../../../src/features/RiderShift';
import { formatRating } from '../../../src/lib/format';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { space } from '../../../src/theme/tokens';
import { Avatar, Card, Divider, Icon, ListRow, Screen, StatusPill, Text } from '../../../src/ui';
import { AppearanceRow } from '../../../src/ui/AppearanceRow';

export default function RiderProfile() {
  const router = useRouter();
  const { palette } = useTheme();
  const { setMode } = useAppMode();
  const { setOnline } = useRiderShift();

  const toCustomer = (): void => {
    // Leaving the Rider face ends the shift on this device first — a rider who
    // switches to shopping is not silently still Online.
    setOnline(false);
    setMode('customer');
    router.replace('/');
  };

  return (
    <Screen testID="rider-profile">
      <View style={{ paddingHorizontal: space.gutter, gap: space.lg }}>
        <View style={{ height: 52, alignItems: 'center', justifyContent: 'center' }}>
          <Text variant="appBar" accessibilityRole="header">
            Profile & Settings
          </Text>
        </View>

        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Avatar source={RIDER_PROFILE.avatar} name={RIDER_PROFILE.firstName} size={60} />
          <View style={{ flex: 1 }}>
            <Text variant="heading">{RIDER_PROFILE.firstName} O.</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Icon name="star" size={14} color={palette.rating} />
              <Text variant="caption" weight="semibold">
                {formatRating(RIDER_PROFILE.rating)}
              </Text>
              <Text variant="caption" tone="muted">
                ({RIDER_PROFILE.trips} trips)
              </Text>
            </View>
          </View>
        </Card>

        <Card padded={false} style={{ paddingHorizontal: space.lg }}>
          <ListRow icon="account-outline" label="Personal Information" onPress={() => router.push('/settings/personal')} />
          <Divider />
          <ListRow
            icon="card-account-details-outline"
            label="Vehicle & Documents"
            onPress={() => router.push('/settings/vehicle')}
            trailing={
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
                <StatusPill label="Verified" />
                <Icon name="chevron-right" size={22} color={palette.textSubtle} />
              </View>
            }
          />
          <Divider />
          <ListRow icon="bank-outline" label="Bank Account" onPress={() => router.push('/settings/bank')} />
          <Divider />
          <ListRow icon="bell-outline" label="Notifications" onPress={() => router.push('/settings/notifications')} />
          <Divider />
          <AppearanceRow />
          <Divider />
          <ListRow icon="translate" label="Language" value="English" onPress={() => router.push('/settings/language')} />
          <Divider />
          <ListRow icon="help-circle-outline" label="Help & Support" onPress={() => router.push('/rider/inbox')} />
        </Card>

        <Card padded={false} style={{ paddingHorizontal: space.lg }}>
          <ListRow icon="storefront-outline" label="Switch to Customer" onPress={toCustomer} />
          <Divider />
          <ListRow
            icon="logout"
            label="Log Out"
            tone="danger"
            onPress={() => {
              setOnline(false);
              void api.signOut().finally(toCustomer);
            }}
          />
        </Card>
        <SampleDataNote />
      </View>
    </Screen>
  );
}
