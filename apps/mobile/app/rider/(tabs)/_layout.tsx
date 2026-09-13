import { Tabs } from 'expo-router';

import { RIDER_TABS } from '../../../src/navigation/tabs';
import { makeTabBar } from '../../../src/ui/TabBar';

const RiderTabBar = makeTabBar(RIDER_TABS);

/** Home · Earnings · Orders · Inbox · Profile — the Rider board's navigation. */
export default function RiderTabs() {
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <RiderTabBar {...props} />}>
      {RIDER_TABS.map((tab) => (
        <Tabs.Screen key={tab.route} name={tab.route} options={{ title: tab.label }} />
      ))}
    </Tabs>
  );
}
