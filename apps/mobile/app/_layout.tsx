/**
 * The root of the app: fonts, theme, remembered mode, cart, and one stack.
 *
 * The splash screen stays up until the three things that decide the first
 * frame are known — the typeface, the Light/Dark choice, and whether this is a
 * Customer or a Rider launch. Painting before them would flash Light at
 * someone who chose Dark, or the shop grid at a rider mid-shift.
 */

import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/manrope';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import naira400 from '../assets/fonts/DashNairaSign-400.ttf';
import naira500 from '../assets/fonts/DashNairaSign-500.ttf';
import naira600 from '../assets/fonts/DashNairaSign-600.ttf';
import naira700 from '../assets/fonts/DashNairaSign-700.ttf';
import naira800 from '../assets/fonts/DashNairaSign-800.ttf';

import { CartProvider } from '../src/features/CartProvider';
import { ModeProvider, useAppMode } from '../src/features/ModeProvider';
import { SavedProvider } from '../src/features/saved';
import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider';

void SplashScreen.preventAutoHideAsync();

function Shell() {
  const { palette, ready: themeReady } = useTheme();
  const { ready: modeReady } = useAppMode();
  const [fontsLoaded, fontError] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
    // Manrope has no ₦ — see `nairaFamily` in the tokens.
    DashNairaSign_400: naira400,
    DashNairaSign_500: naira500,
    DashNairaSign_600: naira600,
    DashNairaSign_700: naira700,
    DashNairaSign_800: naira800,
  });
  // A font that fails to load must not hold the app on the splash screen for
  // ever: the system face is a worse DASH, not a broken one.
  const ready = themeReady && modeReady && (fontsLoaded || Boolean(fontError));

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: palette.background } }}>
      <Stack.Screen name="(customer)" />
      <Stack.Screen name="rider" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ModeProvider>
          <CartProvider>
            <SavedProvider>
              <Shell />
            </SavedProvider>
          </CartProvider>
        </ModeProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
