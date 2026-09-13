import { useRouter } from 'expo-router';

import { EmptyState, Screen, Text } from '../../../src/ui';
import { space } from '../../../src/theme/tokens';

/**
 * The rider's deliveries. The active one — recovered from the server after a
 * restart, never from local state — and history, once deliveries are wired.
 */
export default function RiderOrders() {
  const router = useRouter();
  return (
    <Screen>
      <Text variant="title" style={{ paddingHorizontal: space.gutter, paddingTop: space.md }} accessibilityRole="header">
        Orders
      </Text>
      <EmptyState
        icon="clipboard-text-outline"
        title="No active delivery"
        body="When you accept an order, it stays here until it is delivered — even if the app is closed."
        action="Go to Home"
        onAction={() => router.push('/rider')}
      />
    </Screen>
  );
}
