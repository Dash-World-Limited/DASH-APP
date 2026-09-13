/**
 * The Rider face: its tabs, the incoming-offer screen, and the job screens.
 *
 * The incoming offer is a full-screen modal. It interrupts whatever the rider
 * was looking at, because it is the one moment in the app that must — and it
 * has its own close control, so it can always be dismissed.
 */

import { Stack } from 'expo-router';

import { RiderShiftProvider } from '../../src/features/RiderShift';
import { useTheme } from '../../src/theme/ThemeProvider';

export default function RiderLayout() {
  const { palette } = useTheme();
  return (
    <RiderShiftProvider>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: palette.background } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="offer/[id]" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
      </Stack>
    </RiderShiftProvider>
  );
}
