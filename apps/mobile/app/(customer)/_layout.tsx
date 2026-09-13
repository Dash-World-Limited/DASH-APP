/**
 * The Customer face: its tabs, and the flow screens pushed over them.
 *
 * A rider who last used DASH as a rider is sent straight to the Rider home —
 * the remembered mode is known before the splash screen hides, so they never
 * see this face first.
 */

import { Redirect, Stack } from 'expo-router';

import { useAppMode } from '../../src/features/ModeProvider';
import { useTheme } from '../../src/theme/ThemeProvider';

export default function CustomerLayout() {
  const { palette } = useTheme();
  const { mode } = useAppMode();
  if (mode === 'rider') return <Redirect href="/rider" />;

  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: palette.background } }} />;
}
