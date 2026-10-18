/**
 * Notifications: one switch, for customers and riders alike. Opening the
 * screen asks Android for nothing; the choice is kept on this phone for the
 * signed-in account (see features/notificationPreference) and reported to
 * DASH, which sends only essential pushes to a phone that has it off. When
 * Android itself is blocking DASH's notifications, the screen says so.
 */

import { useState } from 'react';
import { ActivityIndicator, Linking, Platform, View } from 'react-native';

import { api, ApiError, buildVariant } from '../../api';
import { describeTestNotification, sendTestNotification } from '../../data/devices';

import { useTheme } from '../../theme/ThemeProvider';
import { radius, space } from '../../theme/tokens';
import { Toggle } from '../../ui/Controls';
import { ErrorState } from '../../ui/Display';
import { Icon } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useAppSession } from '../auth/AppSessionProvider';
import { BackHeader, Card, Notice, OrderPage, SecondaryButton } from '../orders/parts';
import { useNotificationPermission } from '../push/useNotificationPermission';
import { useNotificationPreference } from './useNotificationPreference';

export function NotificationSettingsScreen({ audience, onBack }: { audience: 'customer' | 'rider'; onBack: () => void }) {
  const { palette } = useTheme();
  const { viewer } = useAppSession();
  const preference = useNotificationPreference(viewer?.identity.id);
  const permission = useNotificationPermission();

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

      {Platform.OS === 'ios' ? (
        <Notice icon="information-outline" text="Push notifications are not available in this iOS build yet. Open DASH to check your orders, deliveries and messages." />
      ) : null}

      {Platform.OS !== 'ios' && preference.enabled && permission && !permission.granted ? (
        <>
          <Notice icon="bell-alert-outline" text="Android is not letting DASH show notifications on this phone. Allow them in your phone’s settings to get updates while DASH is closed." danger />
          <SecondaryButton label="Open phone settings" onPress={() => void Linking.openSettings()} />
        </>
      ) : null}

      {Platform.OS !== 'ios' && buildVariant !== 'production' ? <TestNotificationCard /> : null}

      {audience === 'rider' ? (
        <Notice icon="information-outline" text="Delivery offers — and word that a delivery you are carrying was cancelled — still reach you while you are online, whatever you choose here." />
      ) : null}
      <Text variant="caption" tone="muted">This choice is saved on this phone for your account, and DASH follows it when sending notifications here.</Text>
    </OrderPage>
  );
}

/**
 * Staging and development builds only: ask DASH to send this account a test
 * notification in ten seconds, so delivery can be checked with the app in the
 * background or closed. The answer says honestly when the service is not
 * connected to Firebase.
 */
function TestNotificationCard() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; problem: boolean } | null>(null);

  const send = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      setNote(describeTestNotification(await sendTestNotification(api, 10)));
    } catch (caught) {
      setNote({ text: caught instanceof ApiError ? caught.message : 'The test notification could not be requested.', problem: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Text variant="bodyStrong">Test notifications</Text>
      <Text variant="caption" tone="muted">Sends a test notification to your phones in about 10 seconds. Only in test builds of DASH.</Text>
      <SecondaryButton label={busy ? 'Sending…' : 'Send a test notification'} onPress={() => void send()} disabled={busy} />
      {note ? <Notice icon={note.problem ? 'alert-circle-outline' : 'bell-ring-outline'} text={note.text} danger={note.problem} /> : null}
    </Card>
  );
}
