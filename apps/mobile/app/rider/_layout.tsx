/**
 * The Rider face: its tabs, the incoming-offer screen, and the job screens.
 *
 * The incoming offer is a full-screen modal. It interrupts whatever the rider
 * was looking at, because it is the one moment in the app that must — and it
 * has its own close control, so it can always be dismissed.
 *
 * Mounting this layout settles a remembered rider's launch redirect (see
 * `modeReducer`), so the Customer layout never sends anyone here twice.
 */

import { Stack } from 'expo-router';
import { useEffect } from 'react';

import { useAppMode } from '../../src/features/ModeProvider';
import { RiderShiftProvider } from '../../src/features/RiderShift';
import { useTheme } from '../../src/theme/ThemeProvider';

export default function RiderLayout() {
  const { palette } = useTheme();
  const { arrivedAt } = useAppMode();

  useEffect(() => arrivedAt('rider'), [arrivedAt]);

  return (
    <RiderShiftProvider>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: palette.background } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="offer/[id]" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
      </Stack>
    </RiderShiftProvider>
  );
}
