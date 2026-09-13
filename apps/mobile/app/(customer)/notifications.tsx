import { AppBar, EmptyState, Screen } from '../../src/ui';

/** Notifications. Order and delivery updates land here once orders are placed. */
export default function Notifications() {
  return (
    <Screen>
      <AppBar title="Notifications" />
      <EmptyState
        icon="bell-outline"
        title="Nothing new"
        body="Order confirmations, delivery updates and messages from DASH will appear here."
      />
    </Screen>
  );
}
