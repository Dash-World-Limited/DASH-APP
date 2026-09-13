import { Stack } from 'expo-router';

import { useTheme } from '../../../../src/theme/ThemeProvider';

/** The Rider Home tab's own stack: the dashboard, and the Online screen. */
export default function RiderHomeStack() {
  const { palette } = useTheme();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: palette.background } }} />;
}
