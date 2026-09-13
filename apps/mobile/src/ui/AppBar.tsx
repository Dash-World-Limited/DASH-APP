/**
 * The top bar of a pushed screen: back on the left, a centred title, actions
 * on the right — exactly the arrangement every flow screen on both boards uses
 * (Shops, Your Cart, Checkout, Order Details, Navigate).
 *
 * The title is centred on the screen, not in the space left between the
 * controls, so it sits in the same place whether a screen has one action or
 * three. It truncates rather than wrapping under the buttons.
 */

import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { View } from 'react-native';

import { space, touchTarget } from '../theme/tokens';
import type { IconName } from './Icon';
import { IconButton } from './IconButton';
import { Text } from './Text';

export function AppBar({
  title,
  onBack,
  back = true,
  backIcon = 'chevron-left',
  right,
  overlay = false,
}: {
  title?: string;
  /** Defaults to the router's back. */
  onBack?: () => void;
  back?: boolean;
  /** `close` for a modal the board dismisses with an ✕ — the incoming offer. */
  backIcon?: Extract<IconName, 'chevron-left' | 'close'>;
  right?: ReactNode;
  /** Drawn over photography — glyphs sit on small scrim plates so they read. */
  overlay?: boolean;
}) {
  const router = useRouter();
  return (
    <View
      style={{
        height: 52,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: space.xs,
      }}
    >
      <View style={{ width: touchTarget * 2, flexDirection: 'row' }}>
        {back ? (
          <IconButton
            icon={backIcon}
            size={backIcon === 'close' ? 26 : 30}
            label={backIcon === 'close' ? 'Close' : 'Back'}
            plate={overlay ? 'scrim' : 'none'}
            onPress={onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/')))}
          />
        ) : null}
      </View>
      <View style={{ flex: 1, alignItems: 'center' }} pointerEvents="none">
        {title ? (
          <Text variant="appBar" numberOfLines={1} accessibilityRole="header">
            {title}
          </Text>
        ) : null}
      </View>
      <View style={{ width: touchTarget * 2, flexDirection: 'row', justifyContent: 'flex-end' }}>
        {right}
      </View>
    </View>
  );
}
