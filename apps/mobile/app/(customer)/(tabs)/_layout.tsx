import { Tabs } from 'expo-router';

import { CUSTOMER_TABS, HIDDEN_CUSTOMER_ROUTES } from '../../../src/navigation/tabs';
import { makeTabBar } from '../../../src/ui/TabBar';

const CustomerTabBar = makeTabBar(CUSTOMER_TABS);

/** Home · Orders · Wallet · Support — the Customer board's navigation. */
export default function CustomerTabs() {
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <CustomerTabBar {...props} />}>
      {CUSTOMER_TABS.map((tab) => (
        <Tabs.Screen key={tab.route} name={tab.route} options={{ title: tab.label }} />
      ))}
      {HIDDEN_CUSTOMER_ROUTES.map((route) => (
        <Tabs.Screen key={route} name={route} options={{ href: null }} />
      ))}
    </Tabs>
  );
}
