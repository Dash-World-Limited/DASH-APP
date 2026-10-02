import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/manrope';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, BackHandler, Pressable, ScrollView, Switch, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { formatNairaCompact, type Kobo } from '@dash/domain/money';

import naira400 from '../../assets/fonts/DashNairaSign-400.ttf';
import naira500 from '../../assets/fonts/DashNairaSign-500.ttf';
import naira600 from '../../assets/fonts/DashNairaSign-600.ttf';
import naira700 from '../../assets/fonts/DashNairaSign-700.ttf';
import naira800 from '../../assets/fonts/DashNairaSign-800.ttf';
import { api, ApiError } from '../api';
import { Wordmark } from '../brand/Wordmark';
import { CartProvider } from '../features/CartProvider';
import { ModeProvider, useAppMode } from '../features/ModeProvider';
import { ThemeProvider, useTheme } from '../theme/ThemeProvider';
import { radius, space, touchTarget } from '../theme/tokens';
import { Icon, type IconName } from '../ui/Icon';
import { Text } from '../ui/Text';
import type { ServiceId } from './artwork/CategoryArtwork';
import { CategoryPhoto } from './artwork/CategoryPhoto';
import { AccountSessionCard } from './auth/AccountSessionCard';
import { AuthGate } from './auth/AuthGate';
import { DeleteAccountScreen } from './account/DeleteAccountScreen';
import { AppSessionProvider, useAppSession } from './auth/AppSessionProvider';
import { RegisterScreen } from './auth/RegisterScreen';
import { viewerFirstName, viewerInitials } from './auth/viewerName';
import { LegalScreen } from './legal/LegalScreen';
import { WalletScreen } from './wallet/WalletScreen';
import { RiderApplyScreen } from './rider/RiderApplyScreen';
import { CartScreen, CategoryDashboard, CustomerSearchScreen, ProductDetail, Storefront } from './catalog/CatalogScreens';
import {
  CUSTOMER_TABS,
  RIDER_TABS,
  createNavigationState,
  currentRoute,
  goBack,
  navigate,
  selectTab,
  switchFace,
  type AppFace,
  type AppRoute,
  type NavigationState,
} from './navigation/model';
import { CustomerCheckoutScreen } from './orders/CheckoutScreen';
import { OrderChatScreen } from './chat/OrderChatScreen';
import { CustomerOrdersScreen, CustomerTrackingScreen } from './orders/CustomerOrderScreens';
import { RiderFlowProvider, useRiderFlow } from './rider/RiderFlowProvider';
import { RiderCompleteScreen, RiderDeliveryScreen, RiderOfferScreen, RiderOnlineScreen, RiderOrdersScreen, RiderRouteScreen } from './rider/RiderScreens';

void SplashScreen.preventAutoHideAsync();

const SERVICES: ReadonlyArray<{ id: ServiceId; label: string; color: string }> = [
  { id: 'food', label: 'Food', color: '#E7B66C' },
  { id: 'shops', label: 'Shops', color: '#8AA7C7' },
  { id: 'pharmacy', label: 'Pharmacy', color: '#8EBA9A' },
  { id: 'local-market', label: 'Local Market', color: '#D58C65' },
  { id: 'declutter', label: 'Declutter', color: '#B699C6' },
  { id: 'logistics', label: 'Logistics', color: '#92A88A' },
];

const CAMPAIGNS = [
  { title: 'Good Food\nBrighter Days', body: 'Order from restaurants near you', action: 'Explore Food', target: 'food', color: '#EADCC6' },
  { title: 'Everyday Finds\nDelivered', body: 'Discover trusted shops around you', action: 'Browse Shops', target: 'shops', color: '#DCE5EC' },
  { title: 'Care When\nYou Need It', body: 'Pharmacy essentials, closer to home', action: 'Find Pharmacy', target: 'pharmacy', color: '#DDE8DE' },
  { title: 'Fresh From\nThe Market', body: 'Produce and ingredients from local sellers', action: 'Shop Market', target: 'local-market', color: '#F0DEC9' },
  { title: 'Great Finds\nNew Stories', body: 'Give quality pre-owned items another life', action: 'Explore Declutter', target: 'declutter', color: '#E6DCEB' },
  { title: 'Send It\nWith DASH', body: 'Move packages safely across the city', action: 'Book Logistics', target: 'logistics', color: '#DCE5D9' },
] as const;

export default function DashApp() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ModeProvider>
          <AppSessionProvider>
            <CartProvider>
              <RiderFlowProvider>
                <Bootstrap />
              </RiderFlowProvider>
            </CartProvider>
          </AppSessionProvider>
        </ModeProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function Bootstrap() {
  const { ready: themeReady, palette } = useTheme();
  const { ready: modeReady } = useAppMode();
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
  const ready = themeReady && modeReady && (fontsLoaded || Boolean(fontError));

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;
  return (
    <View style={{ flex: 1, backgroundColor: palette.background }}>
      <StatusBar style={palette.statusBar} />
      <AuthGate>
        <Navigator />
      </AuthGate>
    </View>
  );
}

function Navigator() {
  const { mode, setMode } = useAppMode();
  const { viewer } = useAppSession();
  const [state, setState] = useState<NavigationState>(() => createNavigationState(mode));
  const route = currentRoute(state);

  const push = useCallback((next: AppRoute) => setState((current) => navigate(current, next)), []);
  const tab = useCallback((next: AppRoute) => setState((current) => selectTab(current, next)), []);
  const back = useCallback(() => setState((current) => goBack(current)), []);
  const changeFace = useCallback(
    (face: AppFace) => {
      if (face === 'rider' && viewer?.riderStatus !== 'approved') return;
      setMode(face);
      setState((current) => switchFace(current, face));
    },
    [setMode, viewer?.riderStatus],
  );

  useEffect(() => {
    if (mode === 'rider' && viewer?.riderStatus !== 'approved') {
      setMode('customer');
      setState(createNavigationState('customer'));
    }
  }, [mode, setMode, viewer?.riderStatus]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (state.stack.length <= 1) return false;
      back();
      return true;
    });
    return () => subscription.remove();
  }, [back, state.stack.length]);

  const showTabs = isTabRoute(route.name);
  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'left', 'right', 'bottom']}>
      <View style={{ flex: 1 }}>
        <RouteView route={route} onPush={push} onBack={back} onSwitchFace={changeFace} />
      </View>
      {showTabs ? <BottomTabs face={state.face} current={route.name} onSelect={tab} /> : null}
    </SafeAreaView>
  );
}

function isTabRoute(name: AppRoute['name']): boolean {
  return [...CUSTOMER_TABS, ...RIDER_TABS].some((item) => item.name === name);
}

function RouteView({
  route,
  onPush,
  onBack,
  onSwitchFace,
}: {
  route: AppRoute;
  onPush: (route: AppRoute) => void;
  onBack: () => void;
  onSwitchFace: (face: AppFace) => void;
}) {
  switch (route.name) {
    case 'customer.home':
      return <CustomerHome onPush={onPush} />;
    case 'customer.orders':
      return <CustomerOrdersScreen onTrack={(id) => onPush({ name: 'customer.track-order', params: { id } })} onAccount={() => onPush({ name: 'customer.account' })} />;
    case 'customer.wallet':
      return <WalletScreen onAccount={() => onPush({ name: 'customer.account' })} />;
    case 'customer.support':
      return <EmptyPage title="Support" icon="message-question-outline" body="In-app support cases are not available yet. For help with an order, contact DASH with your order code." />;
    case 'customer.account':
      return <CustomerAccount onBack={onBack} onSwitch={() => onSwitchFace('rider')} onPush={onPush} />;
    case 'customer.notifications':
      return <DetailPage title="Notifications" onBack={onBack}><EmptyState icon="bell-outline" title="You’re all caught up" body="Order and account updates will arrive here." /></DetailPage>;
    case 'customer.search':
      return <CustomerSearchScreen onBack={onBack} onPush={onPush} />;
    case 'customer.category':
      return <CategoryDashboard id={route.params?.id ?? 'food'} onBack={onBack} onPush={onPush} />;
    case 'customer.store':
      return <Storefront category={route.params?.category ?? 'food'} merchantId={route.params?.id ?? ''} onBack={onBack} onPush={onPush} />;
    case 'customer.product':
      return <ProductDetail category={route.params?.category ?? 'food'} merchantId={route.params?.store ?? ''} productId={route.params?.id ?? ''} onBack={onBack} onCart={() => onPush({ name: 'customer.cart', params: { product: route.params?.id ?? '' } })} />;
    case 'customer.cart':
      return <CartScreen onBack={onBack} onCheckout={() => onPush({ name: 'customer.checkout' })} />;
    case 'customer.checkout':
      return <CustomerCheckoutScreen onBack={onBack} onAccount={() => onPush({ name: 'customer.account' })} onTrack={(id) => onPush({ name: 'customer.track-order', params: { id } })} />;
    case 'customer.track-order':
      return <CustomerTrackingScreen orderId={route.params?.id ?? ''} onBack={onBack} onChat={(id) => onPush({ name: 'customer.chat', params: { id } })} />;
    case 'customer.chat':
      return <OrderChatScreen orderId={route.params?.id ?? ''} onBack={onBack} />;
    case 'customer.register':
      return <RegisterScreen onBack={onBack} onDone={onBack} onLegal={(slug) => onPush({ name: 'customer.legal', params: { slug } })} />;
    case 'customer.delete-account':
      return <DeleteAccountScreen onBack={onBack} onAccount={() => onPush({ name: 'customer.account' })} />;
    case 'customer.legal':
      return <LegalScreen slug={route.params?.slug ?? 'terms-of-service'} onBack={onBack} />;
    case 'customer.rider-apply':
      return <RiderApplyScreen onBack={onBack} onAccount={() => onPush({ name: 'customer.account' })} />;
    case 'rider.home':
      return <RiderHome onPush={onPush} />;
    case 'rider.earnings':
      return <RiderEarnings />;
    case 'rider.orders':
      return <RiderOrdersScreen onOpen={() => onPush({ name: 'rider.delivery' })} />;
    case 'rider.inbox':
      return <RiderInbox />;
    case 'rider.profile':
      return <RiderProfile onSwitch={() => onSwitchFace('customer')} />;
    case 'rider.online':
      return <RiderOnlineScreen onBack={onBack} onPush={(name) => onPush({ name: `rider.${name}` })} />;
    case 'rider.offer':
      return <RiderOfferScreen onBack={onBack} onPush={(name) => onPush({ name: `rider.${name}` })} />;
    case 'rider.delivery':
      return <RiderDeliveryScreen onBack={onBack} onPush={(name) => onPush({ name: `rider.${name}` })} onChat={(id) => onPush({ name: 'rider.chat', params: { id } })} />;
    case 'rider.chat':
      return <OrderChatScreen orderId={route.params?.id ?? ''} onBack={onBack} />;
    case 'rider.route':
      return <RiderRouteScreen onBack={onBack} />;
    case 'rider.complete':
      return <RiderCompleteScreen onBack={onBack} />;
  }
}

function CustomerHome({ onPush }: { onPush: (route: AppRoute) => void }) {
  const { palette } = useTheme();
  const { viewer } = useAppSession();
  const [campaign, setCampaign] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setCampaign((current) => (current + 1) % CAMPAIGNS.length), 3000);
    return () => clearInterval(timer);
  }, []);

  const activeCampaign = CAMPAIGNS[campaign] ?? CAMPAIGNS[0];
  return (
    <Page testID="customer-home-v2">
      <Header
        right={<AvatarButton label="Open your profile" initials={viewerInitials(viewer)} onPress={() => onPush({ name: 'customer.account' })} />}
      />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Change delivery address"
        style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}
      >
        <Icon name="map-marker-outline" color={palette.text} />
        <View style={{ flex: 1 }}>
          <Text variant="micro" tone="muted">Delivering to</Text>
          <Text variant="label" weight="bold">Choose your delivery address</Text>
        </View>
        <Pressable onPress={() => onPush({ name: 'customer.notifications' })} accessibilityRole="button" accessibilityLabel="Notifications" hitSlop={10}>
          <Icon name="bell-outline" color={palette.text} />
        </Pressable>
      </Pressable>

      <Pressable onPress={() => onPush({ name: 'customer.search' })} accessibilityRole="button" accessibilityLabel="Search DASH" style={{ minHeight: 50, borderRadius: radius.md, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, gap: space.sm }}>
        <Icon name="magnify" color={palette.textMuted} />
        <TextInput
          placeholder="Search restaurants, shops, pharmacy…"
          placeholderTextColor={palette.textSubtle}
          editable={false}
          pointerEvents="none"
          accessibilityLabel="Search DASH"
          style={{ flex: 1, color: palette.text, fontFamily: 'Manrope_500Medium', fontSize: 14 }}
        />
        <Icon name="tune-variant" color={palette.text} />
      </Pressable>

      <View>
        <Text variant="heading" style={{ marginBottom: space.md }}>What do you need?</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
          {SERVICES.map((service) => (
            <ServiceCard key={service.id} {...service} onPress={() => onPush({ name: 'customer.category', params: { id: service.id } })} />
          ))}
        </View>
      </View>

      <Pressable
        onPress={() => onPush({ name: 'customer.category', params: { id: activeCampaign.target } })}
        accessibilityRole="button"
        accessibilityLabel={`${activeCampaign.title.replace('\n', ' ')}. ${activeCampaign.action}`}
        style={{ minHeight: 154, overflow: 'hidden', borderRadius: radius.xl, backgroundColor: activeCampaign.color, padding: space.xl, justifyContent: 'space-between' }}
      >
        <View style={{ position: 'absolute', right: -24, bottom: -34, width: 156, height: 156, borderRadius: 78, backgroundColor: 'rgba(255,255,255,0.55)' }} />
        <View style={{ position: 'absolute', right: -8, top: 4 }}>
          <CategoryPhoto id={activeCampaign.target} size={142} accessibilityLabel={`${activeCampaign.target} promotion`} />
        </View>
        <Text variant="title" style={{ color: '#30230F', maxWidth: '64%' }}>{activeCampaign.title}</Text>
        <View style={{ maxWidth: '67%' }}>
          <Text variant="caption" style={{ color: '#5B4B34' }}>{activeCampaign.body}</Text>
          <Text variant="label" weight="bold" style={{ color: '#30230F', marginTop: space.sm }}>{activeCampaign.action}  →</Text>
        </View>
        <View style={{ position: 'absolute', right: space.md, bottom: space.md, flexDirection: 'row', gap: 5 }}>
          {CAMPAIGNS.map((_, index) => <View key={index} style={{ width: index === campaign ? 18 : 5, height: 5, borderRadius: 3, backgroundColor: index === campaign ? '#30230F' : 'rgba(48,35,15,0.3)' }} />)}
        </View>
      </Pressable>
    </Page>
  );
}

function ServiceCard({ id, label, color, onPress }: { id: ServiceId; label: string; color: string; onPress: () => void }) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        width: '30.5%',
        minHeight: 118,
        borderRadius: radius.lg,
        padding: space.sm,
        alignItems: 'center',
        justifyContent: 'center',
        gap: space.sm,
        backgroundColor: pressed ? palette.sand : palette.surface,
        borderWidth: 1,
        borderColor: palette.line,
      })}
    >
      <View style={{ width: 78, height: 72, borderRadius: 24, backgroundColor: `${color}28`, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <CategoryPhoto id={id} size={74} accessibilityLabel={`${label} category photo`} />
      </View>
      <Text variant="caption" weight="bold" align="center">{label}</Text>
    </Pressable>
  );
}

function RiderHome({ onPush }: { onPush: (route: AppRoute) => void }) {
  const { palette } = useTheme();
  const flow = useRiderFlow();
  const { viewer } = useAppSession();
  const firstName = viewerFirstName(viewer);
  const changeAvailability = (next: boolean) => {
    if (next) {
      void flow.goOnline().then((ok) => ok && onPush({ name: 'rider.online' }));
    } else {
      void flow.goOffline();
    }
  };
  return (
    <Page testID="rider-home-v2">
      <Header right={<AvatarButton label="Open rider profile" initials={viewerInitials(viewer)} onPress={() => onPush({ name: 'rider.profile' })} />} />
      {/*
        The rider's own first name, from /v1/auth/me and nowhere else. No
        greeting: it dated the screen to the hour and said nothing. When the
        profile has no name — signed out, or a build with no API origin — the
        line is omitted rather than filled with a stand-in.
      */}
      {firstName ? (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <Text variant="title" testID="rider-first-name">{firstName}</Text>
        </View>
      ) : null}
      <Pressable onPress={() => onPush({ name: 'rider.earnings' })}>
        <Surface>
          <Text variant="caption" tone="muted">Today’s Earnings</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text variant="display" style={{ flex: 1 }}>₦0</Text>
            <Icon name="chevron-right" color={palette.accent} size={28} />
          </View>
        </Surface>
      </Pressable>
      <Surface row>
        <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: flow.online ? palette.success : palette.textSubtle }} />
        <Pressable disabled={!flow.online} onPress={() => onPush({ name: 'rider.online' })} style={{ flex: 1 }}><Text variant="heading">{flow.busy ? 'Updating…' : flow.online ? 'Online' : 'Offline'}</Text>{flow.online ? <Text variant="micro" tone="accent">Tap to view dispatch</Text> : null}</Pressable>
        <Switch disabled={flow.busy} value={flow.online} onValueChange={changeAvailability} trackColor={{ false: palette.sand, true: palette.accent }} thumbColor={palette.surface} accessibilityLabel={flow.online ? 'Go offline' : 'Go online'} />
      </Surface>
      {flow.error ? <Surface row><Icon name="alert-circle-outline" color={palette.danger} /><Text variant="caption" style={{ flex: 1, color: palette.danger }}>{flow.error}</Text></Surface> : null}
      {flow.delivery && flow.delivery.status !== 'delivered' ? <Pressable onPress={() => onPush({ name: 'rider.delivery' })}><Surface row><Icon name="bike-fast" color={palette.accent} /><View style={{ flex: 1 }}><Text variant="caption" tone="muted">Active delivery</Text><Text variant="label" weight="bold">{flow.delivery.code}</Text></View><Icon name="chevron-right" color={palette.accent} /></Surface></Pressable> : null}
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Metric value="0" label="Trips" />
        <Metric value="—" label="Rating" />
        <Metric value="—" label="Completion" />
      </View>
      <Surface row>
        <Icon name="crosshairs-gps" color={palette.accent} />
        <View style={{ flex: 1 }}><Text variant="caption" tone="muted">Current Zone</Text><Text variant="label" weight="bold">Detected when location is enabled</Text></View>
      </Surface>
      <View style={{ minHeight: 128, borderRadius: radius.xl, backgroundColor: palette.accent, padding: space.xl, overflow: 'hidden' }}>
        <View style={{ position: 'absolute', right: -26, top: -22, width: 140, height: 140, borderRadius: 70, backgroundColor: 'rgba(255,255,255,0.18)' }} />
        <Icon name="motorbike" color={palette.onAccent} size={34} />
        <Text variant="heading" tone="onAccent" style={{ marginTop: space.sm }}>Deliver more possibilities</Text>
        <Text variant="caption" tone="onAccent">Rider incentives and bonus campaigns will appear here.</Text>
      </View>
    </Page>
  );
}

/**
 * Earnings, read from /v1/rider/earnings — which reads the ledger rather than
 * a running total, so the balance shown is the one DASH actually owes.
 *
 * The screen showed a hardcoded ₦0 and three ₦0 metrics before this. The
 * endpoint has always existed; nothing was calling it.
 */
function RiderEarnings() {
  const { palette } = useTheme();
  const { state: authState } = useAppSession();
  const [earnings, setEarnings] = useState<RiderEarnings | null>(null);
  const [busy, setBusy] = useState(api.configured);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api.configured || authState !== 'authenticated') {
      setBusy(false);
      return;
    }
    let live = true;
    setBusy(true);
    api.request<RiderEarnings>('/v1/rider/earnings')
      .then((result) => live && (setEarnings(result), setError(null)))
      .catch((caught: unknown) => live && setError(caught instanceof ApiError ? caught.message : 'Could not load your earnings.'))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [authState]);

  return (
    <Page>
      <Header />
      <Text variant="title">Earnings</Text>
      {busy ? <View style={{ minHeight: 160, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={palette.accent} /></View> : null}
      {!api.configured ? <EmptyState icon="cloud-off-outline" title="Not connected to DASH" body="This build has no DASH API address, so there are no earnings to load." /> : null}
      {api.configured && authState !== 'authenticated' ? <EmptyState icon="account-lock-outline" title="Sign in to see your earnings" body="Earnings belong to your approved rider account." /> : null}
      {earnings ? (
        <>
          <Surface>
            <Text variant="caption" tone="muted">Balance owed to you</Text>
            <Text variant="display">{formatNairaCompact(earnings.balanceOwed as Kobo)}</Text>
          </Surface>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Metric value={String(earnings.completedDeliveries)} label="Deliveries" />
          </View>
          {earnings.recentEntries.length === 0 ? (
            <EmptyState icon="chart-line" title="No earnings yet" body="Completed deliveries and payout status will appear here." />
          ) : (
            <Surface>
              <Text variant="label" weight="bold">Recent</Text>
              {earnings.recentEntries.map((entry, index) => (
                <View key={`${entry.at}-${index}`} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.md }}>
                  <View style={{ flex: 1 }}>
                    <Text variant="caption">{entry.memo ?? 'Delivery'}</Text>
                    <Text variant="micro" tone="muted">{new Date(entry.at).toLocaleDateString()}</Text>
                  </View>
                  <Text variant="caption" weight="bold">{formatNairaCompact(entry.amount as Kobo)}</Text>
                </View>
              ))}
            </Surface>
          )}
        </>
      ) : null}
      {error ? <Surface row><Icon name="alert-circle-outline" color={palette.danger} /><Text variant="caption" style={{ flex: 1, color: palette.danger }}>{error}</Text></Surface> : null}
      <Text variant="caption" tone="muted">Figures are the server's, read from the payout ledger. The app never computes a payout total.</Text>
    </Page>
  );
}

interface RiderEarnings {
  balanceOwed: number;
  completedDeliveries: number;
  recentEntries: Array<{ amount: number; memo: string | null; at: string }>;
}

function RiderInbox() {
  return <Page><Header /><Text variant="title">Inbox</Text><Surface><Text variant="label" weight="bold">Operational messages</Text><Text variant="caption" tone="muted">DASH support, safety and account notices live here. Customer chat belongs to the active delivery so riders never confuse the two.</Text></Surface><EmptyState icon="inbox-outline" title="No messages" body="New DASH support messages will appear here." /></Page>;
}

function RiderProfile({ onSwitch }: { onSwitch: () => void }) {
  const { viewer } = useAppSession();
  const name = viewer?.identity.displayName?.trim();
  return <Page><Header /><Text variant="title">Profile & Settings</Text><ProfileHero initials={viewerInitials(viewer)} title={name || 'Your rider profile'} subtitle={name ? 'Rider details arrive with onboarding and approval.' : 'Sign in to see your rider profile.'} /><AppearanceControl /><SettingsRow icon="account-outline" title="Personal profile" note="Onboarding milestone" /><SettingsRow icon="bank-outline" title="Bank account" note="Payout milestone" /><SettingsRow icon="bell-outline" title="Notifications" note="Push milestone" /><SettingsRow icon="lifebuoy" title="Help & support" /><PrimaryAction label="Switch to Customer" icon="account-switch-outline" onPress={onSwitch} /></Page>;
}

function CustomerAccount({ onBack, onSwitch, onPush }: { onBack: () => void; onSwitch: () => void; onPush: (route: AppRoute) => void }) {
  const { viewer, state } = useAppSession();
  const name = viewer?.identity.displayName?.trim();
  const signedIn = state === 'authenticated';
  return (
    <DetailPage title="Account" onBack={onBack}>
      <ProfileHero initials={viewerInitials(viewer)} title={name || 'Welcome to DASH'} subtitle="Your customer account, preferences and Rider access stay in one app." />
      <AccountSessionCard />
      {/* Creating an account is only offered to someone who has not got one. */}
      {!signedIn ? <PrimaryAction label="Create a DASH account" icon="account-plus-outline" onPress={() => onPush({ name: 'customer.register' })} /> : null}
      <AppearanceControl />
      <SettingsRow icon="map-marker-outline" title="Saved addresses" note="Sign-in required" />
      <SettingsRow icon="credit-card-outline" title="Payment methods" note="Sign-in required" />
      <SettingsRow icon="bell-outline" title="Notifications" />
      {viewer?.riderStatus === 'approved'
        ? <PrimaryAction label="Switch to Rider" icon="motorbike" onPress={onSwitch} />
        : <SettingsRow icon="motorbike" title="Apply to ride with DASH" onPress={() => onPush({ name: 'customer.rider-apply' })} />}
      <SettingsRow icon="lifebuoy" title="Help & support" />
      {/* Play requires both documents and account deletion to be reachable
          from inside the app, not only from a website. */}
      <SettingsRow icon="file-document-outline" title="Terms of Service" onPress={() => onPush({ name: 'customer.legal', params: { slug: 'terms-of-service' } })} />
      <SettingsRow icon="shield-account-outline" title="Privacy Policy" onPress={() => onPush({ name: 'customer.legal', params: { slug: 'privacy-policy' } })} />
      {signedIn ? <SettingsRow icon="account-remove-outline" title="Delete my account" onPress={() => onPush({ name: 'customer.delete-account' })} /> : null}
    </DetailPage>
  );
}

function EmptyPage({ title, icon, body }: { title: string; icon: IconName; body: string }) {
  return <Page><Header /><Text variant="title">{title}</Text><EmptyState icon={icon} title={`No ${title.toLowerCase()} yet`} body={body} /></Page>;
}

function DetailPage({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) {
  const { palette } = useTheme();
  return <Page><View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}><Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Go back" style={{ width: touchTarget, height: touchTarget, alignItems: 'center', justifyContent: 'center' }}><Icon name="arrow-left" color={palette.text} /></Pressable><Text variant="appBar">{title}</Text></View>{children}</Page>;
}

function Page({ children, testID }: { children: ReactNode; testID?: string }) {
  const { palette } = useTheme();
  return <ScrollView testID={testID} style={{ flex: 1, backgroundColor: palette.background }} contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.xxxl, gap: space.lg }} showsVerticalScrollIndicator={false}>{children}</ScrollView>;
}

function Header({ right }: { right?: ReactNode }) {
  return <View style={{ height: 54, alignItems: 'center', justifyContent: 'center' }}><Wordmark />{right ? <View style={{ position: 'absolute', right: 0 }}>{right}</View> : null}</View>;
}

/**
 * `initials` is null whenever the signed-in name is unknown. The avatar then
 * shows a neutral person glyph — never stand-in letters, which read as a real
 * account's initials.
 */
function AvatarButton({ label, initials, onPress }: { label: string; initials: string | null; onPress: () => void }) {
  const { palette } = useTheme();
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: palette.inverse, alignItems: 'center', justifyContent: 'center' }}>{initials ? <Text variant="micro" tone="onInverse">{initials}</Text> : <Icon name="account-outline" size={22} color={palette.textOnInverse} />}</Pressable>;
}

function Surface({ children, row = false }: { children: ReactNode; row?: boolean }) {
  const { palette } = useTheme();
  return <View style={{ borderRadius: radius.lg, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, padding: space.lg, gap: space.sm, ...(row ? { flexDirection: 'row', alignItems: 'center' } : {}) }}>{children}</View>;
}

function Metric({ value, label, compact = false }: { value: string; label: string; compact?: boolean }) {
  const { palette } = useTheme();
  return <View style={{ flex: compact ? undefined : 1, minWidth: compact ? 78 : undefined, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, backgroundColor: palette.surfaceMuted, paddingHorizontal: space.md, paddingVertical: compact ? space.sm : space.md }}><Text variant={compact ? 'label' : 'heading'} weight="bold">{value}</Text><Text variant="micro" tone="muted">{label}</Text></View>;
}

function EmptyState({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  const { palette } = useTheme();
  return <View style={{ minHeight: 250, alignItems: 'center', justifyContent: 'center', padding: space.xxl, gap: space.sm }}><View style={{ width: 70, height: 70, borderRadius: 24, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} color={palette.accent} size={34} /></View><Text variant="heading" align="center">{title}</Text><Text tone="muted" align="center">{body}</Text></View>;
}

function ProfileHero({ initials, title, subtitle }: { initials: string | null; title: string; subtitle: string }) {
  const { palette } = useTheme();
  return <View style={{ alignItems: 'center', gap: space.sm, paddingVertical: space.md }}><View style={{ width: 76, height: 76, borderRadius: 38, backgroundColor: palette.inverse, alignItems: 'center', justifyContent: 'center' }}>{initials ? <Text variant="heading" tone="onInverse">{initials}</Text> : <Icon name="account-outline" size={38} color={palette.textOnInverse} />}</View><Text variant="heading">{title}</Text><Text variant="caption" tone="muted" align="center">{subtitle}</Text></View>;
}

/** A row that goes somewhere when `onPress` is given, and reads as a label when not. */
function SettingsRow({ icon, title, note, onPress }: { icon: IconName; title: string; note?: string; onPress?: () => void }) {
  const { palette } = useTheme();
  const body = <Surface row><Icon name={icon} color={palette.accent} /><View style={{ flex: 1 }}><Text variant="label" weight="bold">{title}</Text>{note ? <Text variant="micro" tone="muted">{note}</Text> : null}</View><Icon name="chevron-right" color={palette.textSubtle} /></Surface>;
  return onPress ? <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title}>{body}</Pressable> : body;
}

function AppearanceControl() {
  const { scheme, setAppearance, palette } = useTheme();
  return <Surface><Text variant="label" weight="bold">Appearance</Text><View style={{ flexDirection: 'row', padding: 4, borderRadius: radius.md, backgroundColor: palette.surfaceMuted }}>{(['light', 'dark'] as const).map((option) => { const active = option === scheme; return <Pressable key={option} onPress={() => setAppearance(option)} accessibilityRole="button" accessibilityState={{ selected: active }} accessibilityLabel={`Use ${option} appearance`} style={{ flex: 1, minHeight: 40, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? palette.inverse : 'transparent' }}><Text variant="caption" tone={active ? 'onInverse' : 'muted'} weight="bold">{option === 'light' ? 'Light' : 'Dark'}</Text></Pressable>; })}</View></Surface>;
}

function PrimaryAction({ label, icon, onPress }: { label: string; icon: IconName; onPress: () => void }) {
  const { palette } = useTheme();
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => ({ minHeight: 52, borderRadius: radius.md, backgroundColor: pressed ? palette.accentPressed : palette.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm })}><Icon name={icon} color={palette.onAccent} /><Text variant="label" tone="onAccent" weight="bold">{label}</Text></Pressable>;
}

function BottomTabs({ face, current, onSelect }: { face: AppFace; current: AppRoute['name']; onSelect: (route: AppRoute) => void }) {
  const { palette } = useTheme();
  const tabs = face === 'customer' ? CUSTOMER_TABS : RIDER_TABS;
  return <View accessibilityRole="tablist" style={{ minHeight: 68, paddingTop: space.sm, flexDirection: 'row', backgroundColor: palette.surface, borderTopWidth: 1, borderTopColor: palette.line }}>{tabs.map((item) => { const active = current === item.name; return <Pressable key={item.name} onPress={() => onSelect({ name: item.name })} accessibilityRole="tab" accessibilityState={{ selected: active }} accessibilityLabel={item.label} style={{ flex: 1, alignItems: 'center', gap: 2 }}><Icon name={(active ? item.activeIcon : item.icon) as IconName} size={23} color={active ? palette.tabActive : palette.tabInactive} /><Text variant="micro" style={{ color: active ? palette.tabActive : palette.tabInactive }}>{item.label}</Text></Pressable>; })}</View>;
}
