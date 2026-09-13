import { Tabs } from 'expo-router';

import { CUSTOMER_TABS } from '../../../src/navigation/tabs';
import { makeTabBar } from '../../../src/ui/TabBar';

const CustomerTabBar = makeTabBar(CUSTOMER_TABS);

/** Home · Orders · Wallet · Support — the Customer board's navigation. */
export default function CustomerTabs() {
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <CustomerTabBar {...props} />}>
      {CUSTOMER_TABS.map((tab) => (
        <Tabs.Screen key={tab.route} name={tab.route} options={{ title: tab.label }} />
      ))}
    </Tabs>
  );
}
