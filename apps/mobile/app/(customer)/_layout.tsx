/**
 * The Customer face: its tabs, and the flow screens pushed over them.
 *
 * Every launch opens here, at `/`. A rider who closed DASH on the Rider face is
 * sent on to it, once, before the splash screen hides: that is the only
 * redirect in this layout, and it answers `launchFace`, a launch-time fact,
 * never `mode`. Interactive Customer/Rider switches are owned by their switch
 * buttons, and switching clears `launchFace` before they navigate, so this
 * layout can never add a second navigation to a switch (see `modeReducer`).
 */

import { Redirect, Stack } from 'expo-router';

import { hrefForMode } from '../../src/features/mode';
import { useAppMode } from '../../src/features/ModeProvider';
import { useTheme } from '../../src/theme/ThemeProvider';

export default function CustomerLayout() {
  const { palette } = useTheme();
  const { launchFace } = useAppMode();

  if (launchFace === 'rider') return <Redirect href={hrefForMode('rider')} />;

  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: palette.background } }} />;
}
