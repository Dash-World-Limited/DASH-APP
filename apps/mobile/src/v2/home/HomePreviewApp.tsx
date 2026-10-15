import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/manrope';
import { StatusBar } from 'expo-status-bar';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import naira400 from '../../../assets/fonts/DashNairaSign-400.ttf';
import naira500 from '../../../assets/fonts/DashNairaSign-500.ttf';
import naira600 from '../../../assets/fonts/DashNairaSign-600.ttf';
import naira700 from '../../../assets/fonts/DashNairaSign-700.ttf';
import naira800 from '../../../assets/fonts/DashNairaSign-800.ttf';
import { Wordmark } from '../../brand/Wordmark';
import { homeLocationLines } from '../../features/delivery';
import { ThemeProvider, useTheme } from '../../theme/ThemeProvider';
import { radius, space, touchTarget } from '../../theme/tokens';
import { Icon } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import type { ServiceId } from '../artwork/CategoryArtwork';
import { CategoryPhoto } from '../artwork/CategoryPhoto';
import { AppSessionProvider, useAppSession } from '../auth/AppSessionProvider';
import { viewerFirstName, viewerInitials } from '../auth/viewerName';
import { useDeliveryLocation } from '../orders/useDeliveryLocation';

const SERVICES: ReadonlyArray<{ id: ServiceId; label: string; color: string }> = [
  { id: 'food', label: 'Food', color: '#E7B66C' },
  { id: 'shops', label: 'Shops', color: '#8AA7C7' },
  { id: 'pharmacy', label: 'Pharmacy', color: '#8EBA9A' },
  { id: 'local-market', label: 'Local Market', color: '#D58C65' },
  { id: 'declutter', label: 'Declutter', color: '#B699C6' },
  { id: 'logistics', label: 'Logistics', color: '#92A88A' },
];

export default function HomePreviewApp() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AppSessionProvider>
          <Bootstrap />
        </AppSessionProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function Bootstrap() {
  const { ready, palette } = useTheme();
  const [fontsLoaded, fontError] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
    DashNairaSign_400: naira400,
    DashNairaSign_500: naira500,
    DashNairaSign_600: naira600,
    DashNairaSign_700: naira700,
    DashNairaSign_800: naira800,
  });

  if (!ready || (!fontsLoaded && !fontError)) return null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }} edges={['top', 'left', 'right', 'bottom']}>
      <StatusBar style={palette.statusBar} />
      <CustomerHomePreview />
    </SafeAreaView>
  );
}

function CustomerHomePreview() {
  const { palette } = useTheme();
  const { viewer } = useAppSession();
  const { location } = useDeliveryLocation();
  const locationLines = homeLocationLines(location);
  const firstName = viewerFirstName(viewer);
  const initials = viewerInitials(viewer);
  const greeting = greetingForHour(new Date().getHours());

  return (
    <ScrollView
      testID="customer-home-repositioning-preview"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: space.gutter, paddingTop: space.md, paddingBottom: space.xxxl, gap: space.xl }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Wordmark height={26} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Notifications"
            style={{ width: touchTarget, height: touchTarget, borderRadius: touchTarget / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.edge }}
          >
            <Icon name="bell-outline" color={palette.text} size={21} />
          </Pressable>
          <View
            accessibilityLabel="Profile"
            style={{ width: touchTarget, height: touchTarget, borderRadius: touchTarget / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.inverse }}
          >
            {initials ? <Text variant="label" weight="bold" style={{ color: palette.textOnInverse }}>{initials}</Text> : <Icon name="account-outline" color={palette.textOnInverse} size={21} />}
          </View>
        </View>
      </View>

      <View style={{ gap: space.xs }}>
        <Text variant="caption" tone="muted">{greeting}</Text>
        {firstName ? <Text variant="title">{firstName}</Text> : null}
        <Text variant="heading" style={{ marginTop: space.xs }}>What are you looking for today?</Text>
      </View>

      <View style={{ gap: space.sm }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={locationLines.accessibilityLabel}
          style={{ minHeight: 58, borderRadius: radius.lg, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.edge, paddingHorizontal: space.md, flexDirection: 'row', alignItems: 'center', gap: space.sm }}
        >
          <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.accentSoft }}>
            <Icon name={location.kind === 'denied' || location.kind === 'unavailable' ? 'map-marker-off-outline' : 'map-marker-outline'} color={palette.accent} size={20} />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="micro" tone="muted">{locationLines.caption}</Text>
            <Text variant="label" weight="bold" numberOfLines={1}>{locationLines.title}</Text>
          </View>
          <Icon name="chevron-down" color={palette.textMuted} size={20} />
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Search DASH"
          style={{ minHeight: 52, borderRadius: radius.lg, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.edge, flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, gap: space.sm }}
        >
          <Icon name="magnify" color={palette.textMuted} size={21} />
          <TextInput
            editable={false}
            pointerEvents="none"
            placeholder="Search DASH"
            placeholderTextColor={palette.textSubtle}
            style={{ flex: 1, color: palette.text, fontFamily: 'Manrope_500Medium', fontSize: 14 }}
          />
        </Pressable>
      </View>

      <View style={{ gap: space.md }}>
        <Text variant="heading">What do you need?</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: space.md }}>
          {SERVICES.map((service) => (
            <ServiceCard key={service.id} {...service} />
          ))}
        </View>
      </View>

      <FeaturedCampaign />
    </ScrollView>
  );
}

function ServiceCard({ id, label, color }: { id: ServiceId; label: string; color: string }) {
  const { palette } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        width: '31.5%',
        minHeight: 116,
        borderRadius: radius.lg,
        padding: space.sm,
        alignItems: 'center',
        justifyContent: 'center',
        gap: space.sm,
        backgroundColor: pressed ? palette.sand : palette.surface,
        borderWidth: 1,
        borderColor: palette.edge,
      })}
    >
      <View style={{ width: 72, height: 68, borderRadius: 22, backgroundColor: `${color}28`, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <CategoryPhoto id={id} size={68} accessibilityLabel={`${label} category`} />
      </View>
      <Text variant="caption" weight="bold" align="center">{label}</Text>
    </Pressable>
  );
}

function FeaturedCampaign() {
  const { palette } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Featured campaign: DASH Auto Care"
      style={{
        minHeight: 166,
        overflow: 'hidden',
        borderRadius: radius.xl,
        backgroundColor: palette.inverse,
        padding: space.xl,
        justifyContent: 'space-between',
      }}
    >
      <View style={{ position: 'absolute', width: 180, height: 180, borderRadius: 90, right: -56, top: -40, backgroundColor: palette.accent }} />
      <View style={{ position: 'absolute', width: 110, height: 110, borderRadius: 55, right: 24, bottom: -54, backgroundColor: palette.accentSoft, opacity: 0.55 }} />

      <View style={{ alignSelf: 'flex-start', paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.pill, backgroundColor: palette.accent }}>
        <Text variant="micro" weight="bold" style={{ color: palette.onAccent }}>FEATURED ON DASH</Text>
      </View>

      <View style={{ maxWidth: '68%', gap: space.xs }}>
        <Text variant="title" style={{ color: palette.textOnInverse }}>DASH Auto Care</Text>
        <Text variant="caption" style={{ color: palette.textOnInverse, opacity: 0.78 }}>A dedicated space for the campaigns, notices and services you choose to showcase.</Text>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Text variant="label" weight="bold" style={{ color: palette.textOnInverse }}>Discover more</Text>
        <Icon name="chevron-right" color={palette.textOnInverse} size={18} />
      </View>
    </Pressable>
  );
}

function greetingForHour(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}
