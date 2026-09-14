/**
 * The bottom navigation both apps share.
 *
 * Drawn to the boards: a white bar with a hairline above it, outlined glyphs,
 * and the active tab's glyph filling in with its label turning graphite. No
 * floating capsule and no glass — the approved boards use neither, and the
 * earlier web direction that did is superseded.
 *
 * It owns the bottom safe area, so the labels never sit under the gesture pill.
 * Each tab is announced as a tab with its selected state, and the bar as a tab
 * list.
 */

import type { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { TabDefinition } from '../navigation/tabs';
import { useTheme } from '../theme/ThemeProvider';
import { space } from '../theme/tokens';
import { Icon } from './Icon';
import { Text } from './Text';

/**
 * The props Expo Router hands a custom tab bar — derived from `Tabs` itself,
 * because Expo Router vendors React Navigation internally from SDK 57 and does
 * not re-export the type. Deriving it survives the next internal move.
 */
type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

export function makeTabBar(tabs: readonly TabDefinition[]) {
  return function TabBar({ state, navigation }: TabBarProps) {
    const { palette } = useTheme();
    const insets = useSafeAreaInsets();

    return (
      <View
        accessibilityRole="tablist"
        style={{
          flexDirection: 'row',
          backgroundColor: palette.surface,
          borderTopWidth: 1,
          borderTopColor: palette.edge,
          paddingTop: space.sm,
          paddingBottom: Math.max(insets.bottom, space.sm),
        }}
      >
        {state.routes.map((route, index) => {
          const tab = tabs.find((t) => t.route === route.name);
          if (!tab) return null;
          const focused = state.index === index;
          const color = focused ? palette.tabActive : palette.tabInactive;

          const onPress = (): void => {
            const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
            if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
          };

          return (
            <Pressable
              key={route.key}
              onPress={onPress}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={tab.label}
              testID={`tab-${tab.route}`}
              style={{ flex: 1, alignItems: 'center', gap: 3, minHeight: 44, justifyContent: 'center' }}
            >
              <Icon name={focused ? tab.activeIcon : tab.icon} size={24} color={color} />
              <Text variant="micro" weight={focused ? 'bold' : 'medium'} style={{ color }}>
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    );
  };
}
