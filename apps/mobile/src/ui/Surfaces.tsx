/**
 * The surfaces content sits on: the screen itself, and cards.
 *
 * `Screen` owns the safe area and the status bar, so no screen has to know
 * where a notch is — the same rule the web shell learned the hard way. The
 * bottom inset is left to whoever owns the bottom edge: the tab bar on a tab
 * screen, a pinned action bar on a flow screen.
 *
 * `Card` is the boards' one card: white on ivory, a hairline edge and the
 * faintest shadow. Flat by policy — see `elevation` in the tokens.
 */

import { StatusBar } from 'expo-status-bar';
import type { ReactNode } from 'react';
import { ScrollView, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { useTheme } from '../theme/ThemeProvider';
import { elevation, radius, space } from '../theme/tokens';

export function Screen({
  children,
  scroll = true,
  edges = ['top'],
  footer,
  contentStyle,
  statusBar,
  testID,
}: {
  children: ReactNode;
  scroll?: boolean;
  edges?: Edge[];
  /** Pinned below the scroll area — a primary action that must always be reachable. */
  footer?: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  /** Override for screens that draw photography under the status bar. */
  statusBar?: 'light' | 'dark';
  testID?: string;
}) {
  const { palette } = useTheme();
  const body = scroll ? (
    <ScrollView
      contentContainerStyle={[{ paddingBottom: space.xxl }, contentStyle]}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[{ flex: 1 }, contentStyle]}>{children}</View>
  );

  return (
    <SafeAreaView testID={testID} edges={edges} style={{ flex: 1, backgroundColor: palette.background }}>
      <StatusBar style={statusBar ?? palette.statusBar} />
      <View style={{ flex: 1 }}>{body}</View>
      {footer}
    </SafeAreaView>
  );
}

/**
 * A bar pinned to the bottom of a flow screen, holding its primary action.
 *
 * It owns the bottom safe area, because on these screens nothing else is at
 * the bottom edge — without it the button sits under the gesture pill.
 */
export function ActionFooter({ children }: { children: ReactNode }) {
  const { palette } = useTheme();
  return (
    <SafeAreaView
      edges={['bottom']}
      style={{
        backgroundColor: palette.background,
        paddingHorizontal: space.gutter,
        paddingTop: space.md,
        paddingBottom: space.sm,
        gap: space.sm,
      }}
    >
      {children}
    </SafeAreaView>
  );
}

export function Card({
  children,
  padded = true,
  style,
  tone = 'surface',
  testID,
}: {
  children: ReactNode;
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
  /** `muted` for recessed tiles (rider stats); `sand` for code boxes and panels. */
  tone?: 'surface' | 'muted' | 'sand';
  testID?: string;
}) {
  const { palette } = useTheme();
  const recessed = tone !== 'surface';
  return (
    <View
      testID={testID}
      style={[
        {
          backgroundColor: tone === 'sand' ? palette.sand : tone === 'muted' ? palette.surfaceMuted : palette.surface,
          borderRadius: radius.lg,
          borderWidth: recessed ? 0 : 1,
          borderColor: palette.edge,
          padding: padded ? space.lg : 0,
          ...(recessed ? elevation.flat : elevation.card),
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** A hairline. */
export function Divider({ inset = 0 }: { inset?: number }) {
  const { palette } = useTheme();
  return <View style={{ height: 1, backgroundColor: palette.line, marginLeft: inset }} />;
}
