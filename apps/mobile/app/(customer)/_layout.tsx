/**
 * The Customer face: its tabs, and the flow screens pushed over them.
 *
 * Startup chooses the remembered face in the root Stack. Interactive
 * Customer/Rider switches are owned by their switch buttons. This layout must
 * stay passive: adding a Redirect here would race that imperative navigation
 * and can make Fabric attach one native view to two parents.
 */

import { Stack } from 'expo-router';

import { useTheme } from '../../src/theme/ThemeProvider';

export default function CustomerLayout() {
  const { palette } = useTheme();

  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: palette.background } }} />;
}
