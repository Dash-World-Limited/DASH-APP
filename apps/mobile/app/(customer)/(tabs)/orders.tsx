import { useRouter } from 'expo-router';

import { EmptyState, Screen, Text } from '../../../src/ui';
import { space } from '../../../src/theme/tokens';

/** Orders. Empty until checkout exists — and it says what will be here. */
export default function Orders() {
  const router = useRouter();
  return (
    <Screen>
      <Text variant="title" style={{ paddingHorizontal: space.gutter, paddingTop: space.md }} accessibilityRole="header">
        Orders
      </Text>
      <EmptyState
        icon="receipt-text-outline"
        title="No orders yet"
        body="When you place an order, you can follow it here from the shop to your door."
        action="Browse Shops"
        onAction={() => router.push('/shops')}
      />
    </Screen>
  );
}
