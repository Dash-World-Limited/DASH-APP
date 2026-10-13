/**
 * Help & Support, for customers (the Support tab, and from Account) and for
 * riders (from Profile).
 *
 * It offers only channels DASH answers on — today, email at the official
 * address — and the help that already exists inside the app. WhatsApp and
 * chat with the DASH team arrive as entries in `SUPPORT_CHANNELS` when they
 * have a real line and a staffed desk; nothing is drawn for them before then.
 */

import { useState } from 'react';
import { Linking, View } from 'react-native';

import { Wordmark } from '../../brand/Wordmark';
import { DASH_SUPPORT_EMAIL, SUPPORT_CHANNELS, supportMailto, whatsappUrl, type SupportAudience, type SupportChannel } from '../../features/support';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, space } from '../../theme/tokens';
import { Icon, type IconName } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { useAppSession } from '../auth/AppSessionProvider';
import { BackHeader, Card, Notice, OrderPage } from '../orders/parts';
import { SettingsItem, SettingsSection } from './SettingsList';

const TIPS: Record<SupportAudience, ReadonlyArray<{ icon: IconName; title: string; body: string }>> = {
  customer: [
    { icon: 'receipt-text-outline', title: 'About an order', body: 'Open it from Orders to see its live status. Once a rider is assigned, you can chat with them there.' },
    { icon: 'cash-refund', title: 'Payments and refunds', body: 'Card payments go through Paystack. A refund’s status is shown on its order.' },
    { icon: 'account-cog-outline', title: 'Your account', body: 'Change your name, phone or addresses from Account. You can also delete your account there.' },
  ],
  rider: [
    { icon: 'bike-fast', title: 'During a delivery', body: 'Use Chat in DASH on the delivery screen to reach the customer about their order.' },
    { icon: 'cash-multiple', title: 'Earnings and payouts', body: 'Your balance comes from DASH’s payout ledger and is shown in Earnings.' },
    { icon: 'map-marker-alert-outline', title: 'Location and offers', body: 'Keep Location on and DASH open with the screen on while you are online, so offers can reach you.' },
  ],
};

export function SupportScreen({ audience, onBack, onOpenChat }: { audience: SupportAudience; onBack?: () => void; onOpenChat?: () => void }) {
  const { palette } = useTheme();
  const { viewer } = useAppSession();
  const [fallback, setFallback] = useState<string | null>(null);

  const open = (url: string, unavailable: string) => {
    setFallback(null);
    void Linking.openURL(url).catch(() => setFallback(unavailable));
  };

  const row = (channel: SupportChannel) => {
    switch (channel.kind) {
      case 'email':
        return (
          <SettingsItem
            key="email"
            icon="email-outline"
            label="Email DASH support"
            detail={channel.address}
            onPress={() => open(supportMailto(channel.address, audience, viewer?.identity.email), `No email app opened. Write to ${channel.address} from your email.`)}
            testID="support-email"
          />
        );
      case 'whatsapp':
        return (
          <SettingsItem
            key="whatsapp"
            icon="whatsapp"
            label="Chat on WhatsApp"
            detail={channel.number}
            onPress={() => open(whatsappUrl(channel.number), `WhatsApp did not open. Message ${channel.number} on WhatsApp.`)}
          />
        );
      case 'chat':
        return onOpenChat ? <SettingsItem key="chat" icon="message-text-outline" label="Chat with DASH" onPress={onOpenChat} /> : null;
    }
  };

  return (
    <OrderPage testID={`${audience}-support-v2`}>
      {onBack ? (
        <BackHeader title="Help & support" onBack={onBack} />
      ) : (
        <>
          <View style={{ height: 54, alignItems: 'center', justifyContent: 'center' }}><Wordmark /></View>
          <Text variant="title">Help & support</Text>
        </>
      )}

      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <View style={{ width: 48, height: 48, borderRadius: radius.md, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="lifebuoy" color={palette.accent} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="heading">How can we help?</Text>
            <Text variant="caption" tone="muted">
              {audience === 'rider'
                ? 'Reach the DASH team about deliveries, earnings or your rider account.'
                : 'Reach the DASH team about orders, payments, refunds or your account.'}
            </Text>
          </View>
        </View>
      </Card>

      <SettingsSection title="Contact DASH">{SUPPORT_CHANNELS.map(row)}</SettingsSection>
      {fallback ? <Notice icon="information-outline" text={fallback} /> : null}
      <Text variant="caption" tone="muted">
        Put your order code in your message — it looks like DASH-AB12CD — so we can find the order straight away.
      </Text>

      <SettingsSection title="Get help faster">
        {TIPS[audience].map((tip) => (
          <View key={tip.title} style={{ flexDirection: 'row', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md }}>
            <View style={{ width: 28, alignItems: 'center', paddingTop: 2 }}>
              <Icon name={tip.icon} size={22} color={palette.accent} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="body" weight="semibold">{tip.title}</Text>
              <Text variant="caption" tone="muted">{tip.body}</Text>
            </View>
          </View>
        ))}
      </SettingsSection>

      <Text variant="micro" tone="subtle" selectable>DASH support · {DASH_SUPPORT_EMAIL}</Text>
    </OrderPage>
  );
}
