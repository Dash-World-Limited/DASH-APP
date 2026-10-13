/**
 * Notifications: one switch, for customers and riders alike. Opening the
 * screen asks Android for nothing; the choice is kept on this phone for the
 * signed-in account (see features/notificationPreference).
 */

import { ActivityIndicator, View } from 'react-native';

import { useTheme } from '../../theme/ThemeProvider';
import { radius, space } from '../../theme/tokens';
import { Toggle } from '../../ui/Controls';
import { ErrorState } from '../../ui/Display';
import { Icon } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useAppSession } from '../auth/AppSessionProvider';
import { BackHeader, Card, Notice, OrderPage } from '../orders/parts';
import { useNotificationPreference } from './useNotificationPreference';

export function NotificationSettingsScreen({ audience, onBack }: { audience: 'customer' | 'rider'; onBack: () => void }) {
  const { palette } = useTheme();
  const { viewer } = useAppSession();
  const preference = useNotificationPreference(viewer?.identity.id);

  return (
    <OrderPage testID={`${audience}-notification-settings-v2`}>
      <BackHeader title="Notifications" onBack={onBack} />

      {preference.loadFailed ? (
        <ErrorState title="Couldn’t read your setting" message="Your notification choice could not be read from this phone." onRetry={preference.retry} />
      ) : (
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <View style={{ width: 44, height: 44, borderRadius: radius.md, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={preference.enabled === false ? 'bell-off-outline' : 'bell-outline'} color={palette.accent} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="bodyStrong">Notifications</Text>
              <Text variant="caption" tone="muted">Receive updates about orders, deliveries and important account activity.</Text>
            </View>
            {preference.enabled === null ? (
              <ActivityIndicator color={palette.accent} accessibilityLabel="Loading your notification setting" />
            ) : (
              <Toggle
                value={preference.enabled}
                onValueChange={(next) => void preference.setEnabled(next)}
                label="Notifications"
                disabled={preference.saving}
              />
            )}
          </View>
        </Card>
      )}

      {preference.error ? <Notice icon="alert-circle-outline" text={preference.error} danger /> : null}

      {audience === 'rider' ? (
        <Notice icon="information-outline" text="Delivery offers always appear in the DASH app while you are online, whatever you choose here." />
      ) : null}
      <Text variant="caption" tone="muted">This choice is saved on this phone for your account.</Text>
    </OrderPage>
  );
}
