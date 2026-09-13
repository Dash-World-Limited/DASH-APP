import { EmptyState, Screen, Text } from '../../../src/ui';
import { space } from '../../../src/theme/tokens';

/** Messages from DASH operations and support. */
export default function RiderInbox() {
  return (
    <Screen>
      <Text variant="title" style={{ paddingHorizontal: space.gutter, paddingTop: space.md }} accessibilityRole="header">
        Inbox
      </Text>
      <EmptyState
        icon="inbox-outline"
        title="No messages"
        body="Messages from DASH operations and support will appear here. Offers never arrive in the inbox — they come to you straight away."
      />
    </Screen>
  );
}
