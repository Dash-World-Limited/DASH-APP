import { Stack } from 'expo-router';

import { useTheme } from '../../../../src/theme/ThemeProvider';

/** The Home tab's own stack: Home, Shops, and the other services' screens. */
export default function HomeStack() {
  const { palette } = useTheme();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: palette.background } }} />;
}
