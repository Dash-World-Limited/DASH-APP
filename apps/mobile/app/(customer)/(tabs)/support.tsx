import * as Linking from 'expo-linking';
import { View } from 'react-native';

import { useTheme } from '../../../src/theme/ThemeProvider';
import { space } from '../../../src/theme/tokens';
import { Card, ListRow, Screen, Text } from '../../../src/ui';

/**
 * Support. Order-specific help arrives with orders; until then the one real
 * channel — the company site — is offered, and nothing pretends to be a live
 * chat.
 */
export default function Support() {
  const { palette } = useTheme();
  return (
    <Screen>
      <View style={{ paddingHorizontal: space.gutter, paddingTop: space.md, gap: space.lg }}>
        <Text variant="title" accessibilityRole="header">
          Support
        </Text>
        <Text variant="body" tone="muted">
          Help with a specific order — a missing item, a late delivery, a refund — opens from that order once you have placed one.
        </Text>
        <Card>
          <ListRow icon="web" label="Visit DASH World" value="dashworldng.com" onPress={() => void Linking.openURL('https://www.dashworldng.com')} />
        </Card>
        <Text variant="caption" style={{ color: palette.textSubtle }}>
          In-app messaging with support arrives with orders.
        </Text>
      </View>
    </Screen>
  );
}
