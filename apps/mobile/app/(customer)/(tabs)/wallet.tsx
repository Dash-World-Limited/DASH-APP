import { EmptyState, Screen, Text } from '../../../src/ui';
import { space } from '../../../src/theme/tokens';

/**
 * Wallet. No balance is shown, because none is known: a wallet balance is
 * derived from the ledger for a signed-in customer, and inventing one — even a
 * zero — would be a financial claim this build cannot back.
 */
export default function Wallet() {
  return (
    <Screen>
      <Text variant="title" style={{ paddingHorizontal: space.gutter, paddingTop: space.md }} accessibilityRole="header">
        Wallet
      </Text>
      <EmptyState
        icon="wallet-outline"
        title="Your DASH Wallet"
        body="Your balance, refunds and credits appear here once you sign in. Funding your wallet arrives with payments."
      />
    </Screen>
  );
}
