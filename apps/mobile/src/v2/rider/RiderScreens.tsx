import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';

import { MapShell } from '../../rider/MapShell';
import { RouteStops } from '../../rider/RouteStops';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, space, touchTarget } from '../../theme/tokens';
import { Icon, type IconName } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { type DeliveryStatus, useRiderFlow } from './RiderFlowProvider';

interface ScreenProps {
  onBack: () => void;
  onPush: (name: 'offer' | 'delivery' | 'route' | 'complete') => void;
}

export function RiderOnlineScreen({ onBack, onPush }: ScreenProps) {
  const { palette } = useTheme();
  const flow = useRiderFlow();

  return (
    <RiderPage>
      <RiderHeader title="You’re online" onBack={onBack} />
      <StatusNotice preview={flow.preview} />
      {flow.riderPosition ? (
        <View style={{ borderRadius: radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: palette.line }}>
          <MapShell
            route={[]}
            rider={flow.riderPosition}
            followRider
            routeColor={palette.accent}
            height={300}
            accessibilityLabel="Your live rider location"
          />
        </View>
      ) : (
        <View style={{ minHeight: 220, alignItems: 'center', justifyContent: 'center', gap: space.md }}>
          <ActivityIndicator />
          <Text variant="heading">Finding your live location…</Text>
          <Text variant="caption" tone="muted" align="center">Keep location enabled while you are online. DASH will not offer work until your position is fresh.</Text>
        </View>
      )}
      <View style={{ gap: space.xs }}>
        <Text variant="heading">Looking for nearby orders…</Text>
        <Text variant="caption" tone="muted">Your phone’s live GPS position is sent while you are online so dispatch can offer orders you can actually reach.</Text>
      </View>

      {flow.delivery && flow.delivery.status !== 'delivered' ? (
        <ActionCard icon="bike-fast" title={`Active delivery · ${flow.delivery.code}`} body={statusLabel(flow.delivery.status)} action="Open delivery" onPress={() => onPush('delivery')} />
      ) : null}

      {flow.offer ? (
        <ActionCard icon="bell-ring-outline" title="New delivery offer" body={`${flow.offer.order.pickup.name} · ${metres(flow.offer.pickupDistanceMetres)} away`} action="Review offer" onPress={() => onPush('offer')} />
      ) : flow.preview ? (
        <PrimaryButton label="Preview an incoming order" icon="package-variant-closed" onPress={() => { flow.previewOffer(); onPush('offer'); }} />
      ) : (
        <SecondaryButton label="Check for orders now" onPress={() => void flow.findOffers()} />
      )}

      {flow.error ? <ErrorNotice message={flow.error} /> : null}
      <SecondaryButton label={flow.busy ? 'Updating…' : 'Go offline'} onPress={() => void flow.goOffline().then((ok) => ok && onBack())} disabled={flow.busy} />
    </RiderPage>
  );
}

export function RiderOrdersScreen({ onOpen }: { onOpen: () => void }) {
  const flow = useRiderFlow();
  return (
    <RiderPage>
      <View style={{ height: 54, justifyContent: 'center' }}><Text variant="title">Orders</Text></View>
      <Text variant="heading">Active delivery</Text>
      {flow.delivery && flow.delivery.status !== 'delivered' ? (
        <ActionCard icon="bike-fast" title={flow.delivery.code} body={`${flow.delivery.branch.name} · ${statusLabel(flow.delivery.status)}`} action="Open delivery" onPress={onOpen} />
      ) : <Empty icon="bike-fast" title="No active delivery" body="An accepted delivery appears here until handover is complete." compact />}
      <Text variant="heading">History</Text>
      {flow.delivery?.status === 'delivered' ? <HistoryCard code={flow.delivery.code} merchant={flow.delivery.branch.name} status="Delivered" /> : null}
      {flow.preview ? <><HistoryCard code="DASH710842" merchant="Wellspring Pharmacy" status="Delivered" /><HistoryCard code="DASH692015" merchant="TechWorld" status="Delivered" /><StatusNotice preview /></> : null}
      {!flow.preview && flow.delivery?.status !== 'delivered' ? <Empty icon="clipboard-text-clock-outline" title="No completed deliveries yet" body="Delivered and cancelled jobs are loaded from the rider delivery history." compact /> : null}
    </RiderPage>
  );
}

export function RiderOfferScreen({ onBack, onPush }: ScreenProps) {
  const flow = useRiderFlow();
  const offer = flow.offer;
  const [remaining, setRemaining] = useState(() => secondsRemaining(offer?.expiresAt));

  useEffect(() => {
    const timer = setInterval(() => setRemaining(secondsRemaining(offer?.expiresAt)), 1_000);
    return () => clearInterval(timer);
  }, [offer?.expiresAt]);

  if (!offer) {
    return <RiderPage><RiderHeader title="Delivery offer" onBack={onBack} /><Empty icon="timer-off-outline" title="This offer is no longer available" body="Return online to wait for another delivery." /><PrimaryButton label="Back online" icon="arrow-left" onPress={onBack} /></RiderPage>;
  }

  return (
    <RiderPage>
      <RiderHeader title="Incoming order" onBack={onBack} />
      <View style={{ alignItems: 'center', gap: space.xs }}><Text variant="display">{remaining}s</Text><Text variant="caption" tone="muted">to respond</Text></View>
      <Card>
        <RouteStops
          pickup={{ title: offer.order.pickup.name, detail: offer.order.pickup.address }}
          dropoff={{ title: 'Approximate drop-off area', detail: offer.order.dropoffArea ? 'Exact address appears only after acceptance' : 'Pickup order' }}
        />
      </Card>
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Metric icon="map-marker-distance" value={metres(offer.order.tripDistanceMetres)} label="Trip" />
        <Metric icon="package-variant" value={String(offer.order.itemCount)} label="Items" />
        <Metric icon="map-marker-radius-outline" value={metres(offer.pickupDistanceMetres)} label="To pickup" />
      </View>
      <InfoNotice icon="shield-lock-outline" message="Customer identity and exact address remain private until you accept." />
      {flow.error ? <ErrorNotice message={flow.error} /> : null}
      <PrimaryButton
        label={flow.busy ? 'Accepting…' : 'Accept delivery'}
        icon="check-circle-outline"
        disabled={flow.busy || remaining <= 0}
        onPress={() => void flow.respondToOffer(true).then((id) => id && onPush('delivery'))}
      />
      <SecondaryButton label="Decline" disabled={flow.busy} onPress={() => void flow.respondToOffer(false).then(() => onBack())} />
    </RiderPage>
  );
}

export function RiderDeliveryScreen({ onBack, onPush, onChat }: ScreenProps & { onChat: (orderId: string) => void }) {
  const flow = useRiderFlow();
  const delivery = flow.delivery;

  if (!delivery) return <RiderPage><RiderHeader title="Order details" onBack={onBack} /><Empty icon="bike-fast" title="No active delivery" body="Accepted work will appear here." /></RiderPage>;

  const next = nextAction(delivery.status);
  return (
    <RiderPage>
      <RiderHeader title="Order details" onBack={onBack} />
      <StatusNotice preview={flow.preview} />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View><Text variant="micro" tone="muted">Order</Text><Text variant="heading">{delivery.code}</Text></View>
        <StatusPill status={delivery.status} />
      </View>
      <Card>
        <RouteStops pickup={{ title: delivery.branch.name, detail: delivery.branch.address }} dropoff={{ title: delivery.address.line1, detail: delivery.address.landmark }} />
      </Card>
      <ContactRow phone={delivery.address.contactPhone} onMessage={() => onChat(delivery.id)} />
      <Card>
        <Text variant="label" weight="bold">Order items ({delivery.items.reduce((total, item) => total + item.quantity, 0)})</Text>
        {delivery.items.map((item) => <View key={item.name} style={{ flexDirection: 'row', gap: space.sm }}><Text variant="caption" tone="accent">{item.quantity}×</Text><Text variant="caption" style={{ flex: 1 }}>{item.name}</Text></View>)}
      </Card>
      {delivery.address.instructions ? <InfoNotice icon="message-text-outline" message={delivery.address.instructions} /> : null}
      {flow.error ? <ErrorNotice message={flow.error} /> : null}
      {delivery.status === 'delivered' ? <Empty icon="check-decagram-outline" title="Delivery completed" body="The job has moved to your history and earnings." /> : null}
      {next?.kind === 'route' ? <PrimaryButton label={next.label} icon="navigation-variant-outline" onPress={() => onPush('route')} /> : null}
      {next?.kind === 'progress' ? <PrimaryButton label={next.label} icon="arrow-right-circle-outline" disabled={flow.busy} onPress={() => void flow.progress(next.to).then((ok) => ok && (next.to === 'arrived' ? onPush('complete') : undefined))} /> : null}
      {next?.kind === 'complete' ? <PrimaryButton label={next.label} icon="shield-check-outline" onPress={() => onPush('complete')} /> : null}
    </RiderPage>
  );
}

export function RiderRouteScreen({ onBack }: Pick<ScreenProps, 'onBack'>) {
  const { palette } = useTheme();
  const flow = useRiderFlow();
  const delivery = flow.delivery;
  if (!delivery) return <RiderPage><RiderHeader title="Navigation" onBack={onBack} /><Empty icon="map-marker-off-outline" title="No route to show" body="Accept a delivery first." /></RiderPage>;

  const headingToDropoff = delivery.status === 'picked_up' || delivery.status === 'en_route' || delivery.status === 'arrived';
  const destination = headingToDropoff
    ? { latitude: delivery.address.latitude, longitude: delivery.address.longitude }
    : { latitude: delivery.branch.latitude, longitude: delivery.branch.longitude };

  if (!flow.riderPosition) {
    return (
      <RiderPage>
        <RiderHeader title={headingToDropoff ? 'Navigate to customer' : 'Navigate to pickup'} onBack={onBack} />
        <View style={{ minHeight: 240, alignItems: 'center', justifyContent: 'center', gap: space.md }}>
          <ActivityIndicator />
          <Text variant="heading" align="center">Getting your current location…</Text>
          <Text variant="caption" tone="muted" align="center">Navigation starts from the rider phone’s real GPS position.</Text>
        </View>
      </RiderPage>
    );
  }

  const route = interpolateRoute(flow.riderPosition, destination);
  const externalUrl =
    Platform.OS === 'ios'
      ? `http://maps.apple.com/?daddr=${destination.latitude},${destination.longitude}`
      : `geo:${destination.latitude},${destination.longitude}?q=${destination.latitude},${destination.longitude}`;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: palette.background }} contentContainerStyle={{ paddingBottom: space.xxxl }}>
      <View style={{ paddingHorizontal: space.gutter }}><RiderHeader title={headingToDropoff ? 'Navigate to customer' : 'Navigate to pickup'} onBack={onBack} /></View>
      <View style={{ overflow: 'hidden' }}>
        <MapShell route={route} rider={flow.riderPosition} destination={destination} routeColor={palette.accent} height={390} destinationIcon={headingToDropoff ? 'home' : 'storefront-outline'} accessibilityLabel={headingToDropoff ? 'Route to customer' : 'Route to pickup'} />
      </View>
      <View style={{ padding: space.gutter, gap: space.md }}>
        <Card><Text variant="micro" tone="muted">Destination</Text><Text variant="heading">{headingToDropoff ? delivery.address.line1 : delivery.branch.name}</Text><Text variant="caption" tone="muted">{headingToDropoff ? delivery.address.landmark : delivery.branch.address}</Text></Card>
        <SecondaryButton label="Open turn-by-turn navigation" onPress={() => void Linking.openURL(externalUrl)} />
        {headingToDropoff ? (
          <PrimaryButton label="I’ve arrived at drop-off" icon="map-marker-check-outline" disabled={flow.busy || delivery.status === 'arrived'} onPress={() => void flow.progress('arrived').then((ok) => ok && onBack())} />
        ) : (
          <PrimaryButton label="I’ve arrived at pickup" icon="store-check-outline" disabled={flow.busy || delivery.status === 'rider_arrived'} onPress={() => void flow.progress('rider_arrived').then((ok) => ok && onBack())} />
        )}
      </View>
    </ScrollView>
  );
}

export function RiderCompleteScreen({ onBack }: Pick<ScreenProps, 'onBack'>) {
  const flow = useRiderFlow();
  const [pin, setPin] = useState('');
  const delivery = flow.delivery;
  return (
    <RiderPage>
      <RiderHeader title="Complete delivery" onBack={onBack} />
      <Empty icon="shield-key-outline" title="Ask for the delivery PIN" body="The customer reads the four-digit code from their tracking screen. This proves handover." compact />
      {flow.preview ? <InfoNotice icon="flask-outline" message="Interactive preview PIN: 2468" /> : null}
      <TextInput
        value={pin}
        onChangeText={(value) => setPin(value.replace(/\D/g, '').slice(0, 4))}
        keyboardType="number-pad"
        maxLength={4}
        placeholder="4-digit PIN"
        accessibilityLabel="Delivery PIN"
        style={{ minHeight: 62, borderRadius: radius.md, borderWidth: 1, borderColor: '#A9A39A', textAlign: 'center', fontSize: 28, letterSpacing: 12, fontFamily: 'Manrope_700Bold' }}
      />
      {flow.error ? <ErrorNotice message={flow.error} /> : null}
      <PrimaryButton label={flow.busy ? 'Completing…' : 'Confirm delivery'} icon="check-decagram-outline" disabled={flow.busy || pin.length !== 4 || delivery?.status === 'delivered'} onPress={() => void flow.complete(pin).then((ok) => ok && onBack())} />
    </RiderPage>
  );
}

function RiderPage({ children }: { children: ReactNode }) {
  const { palette } = useTheme();
  return <ScrollView style={{ flex: 1, backgroundColor: palette.background }} contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.xxxl, gap: space.lg }} showsVerticalScrollIndicator={false}>{children}</ScrollView>;
}

function RiderHeader({ title, onBack }: { title: string; onBack: () => void }) {
  const { palette } = useTheme();
  return <View style={{ minHeight: 54, flexDirection: 'row', alignItems: 'center' }}><Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Go back" style={{ width: touchTarget, height: touchTarget, alignItems: 'center', justifyContent: 'center' }}><Icon name="arrow-left" color={palette.text} /></Pressable><Text variant="appBar" style={{ flex: 1 }}>{title}</Text></View>;
}

function Card({ children }: { children: ReactNode }) {
  const { palette } = useTheme();
  return <View style={{ padding: space.lg, gap: space.md, borderRadius: radius.lg, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line }}>{children}</View>;
}

function StatusNotice({ preview }: { preview: boolean }) {
  return preview ? <InfoNotice icon="flask-outline" message="Interactive development preview. No real order, customer or payment is involved." /> : null;
}

function InfoNotice({ icon, message }: { icon: IconName; message: string }) {
  const { palette } = useTheme();
  return <View style={{ flexDirection: 'row', gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: palette.accentSoft }}><Icon name={icon} color={palette.accent} /><Text variant="caption" style={{ flex: 1 }}>{message}</Text></View>;
}

function ErrorNotice({ message }: { message: string }) {
  const { palette } = useTheme();
  return <View style={{ flexDirection: 'row', gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: palette.dangerSoft }}><Icon name="alert-circle-outline" color={palette.danger} /><Text variant="caption" style={{ flex: 1, color: palette.danger }}>{message}</Text></View>;
}

function Empty({ icon, title, body, compact = false }: { icon: IconName; title: string; body: string; compact?: boolean }) {
  const { palette } = useTheme();
  return <View style={{ minHeight: compact ? 170 : 250, alignItems: 'center', justifyContent: 'center', gap: space.sm, padding: space.lg }}><View style={{ width: 68, height: 68, borderRadius: 22, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size={32} color={palette.accent} /></View><Text variant="heading" align="center">{title}</Text><Text variant="caption" tone="muted" align="center">{body}</Text></View>;
}

function ActionCard({ icon, title, body, action, onPress }: { icon: IconName; title: string; body: string; action: string; onPress: () => void }) {
  const { palette } = useTheme();
  return <Pressable onPress={onPress} accessibilityRole="button" style={{ padding: space.lg, gap: space.sm, borderRadius: radius.lg, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line }}><View style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}><View style={{ width: 46, height: 46, borderRadius: 16, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} color={palette.accent} /></View><View style={{ flex: 1 }}><Text variant="label" weight="bold">{title}</Text><Text variant="caption" tone="muted">{body}</Text></View><Icon name="chevron-right" color={palette.accent} /></View><Text variant="caption" tone="accent" weight="bold">{action}</Text></Pressable>;
}

function HistoryCard({ code, merchant, status }: { code: string; merchant: string; status: string }) {
  const { palette } = useTheme();
  return <View style={{ minHeight: 76, padding: space.md, borderRadius: radius.lg, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, flexDirection: 'row', alignItems: 'center', gap: space.md }}><View style={{ width: 44, height: 44, borderRadius: 16, backgroundColor: palette.successSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="check-decagram-outline" color={palette.success} /></View><View style={{ flex: 1 }}><Text variant="label" weight="bold">{code}</Text><Text variant="caption" tone="muted">{merchant}</Text></View><Text variant="micro" tone="success" weight="bold">{status}</Text></View>;
}

function Metric({ icon, value, label }: { icon: IconName; value: string; label: string }) {
  const { palette } = useTheme();
  return <View style={{ flex: 1, minHeight: 78, borderRadius: radius.md, backgroundColor: palette.surfaceMuted, alignItems: 'center', justifyContent: 'center', gap: 2 }}><Icon name={icon} size={18} color={palette.accent} /><Text variant="label" weight="bold">{value}</Text><Text variant="micro" tone="muted">{label}</Text></View>;
}

function ContactRow({ phone, onMessage }: { phone: string | null; onMessage: () => void }) {
  return <View style={{ flexDirection: 'row', gap: space.sm }}>{phone ? <View style={{ flex: 1 }}><SecondaryButton label="Call customer" onPress={() => void Linking.openURL(`tel:${phone.replace(/\s/g, '')}`)} /></View> : null}<View style={{ flex: 1 }}><SecondaryButton label="Chat in DASH" onPress={onMessage} /></View></View>;
}

function PrimaryButton({ label, icon, onPress, disabled = false }: { label: string; icon: IconName; onPress: () => void; disabled?: boolean }) {
  const { palette } = useTheme();
  return <Pressable disabled={disabled} onPress={onPress} accessibilityRole="button" accessibilityState={{ disabled }} style={({ pressed }) => ({ minHeight: 52, borderRadius: radius.md, opacity: disabled ? 0.5 : 1, backgroundColor: pressed ? palette.accentPressed : palette.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm })}>{disabled && label.endsWith('…') ? <ActivityIndicator color={palette.onAccent} /> : <Icon name={icon} color={palette.onAccent} />}<Text variant="label" tone="onAccent" weight="bold">{label}</Text></Pressable>;
}

function SecondaryButton({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  const { palette } = useTheme();
  return <Pressable disabled={disabled} onPress={onPress} accessibilityRole="button" accessibilityState={{ disabled }} style={({ pressed }) => ({ minHeight: 50, borderRadius: radius.md, opacity: disabled ? 0.5 : 1, backgroundColor: pressed ? palette.surfaceMuted : palette.surface, borderWidth: 1, borderColor: palette.line, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.md })}><Text variant="caption" weight="bold">{label}</Text></Pressable>;
}

function StatusPill({ status }: { status: DeliveryStatus }) {
  const { palette } = useTheme();
  return <View style={{ paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, backgroundColor: status === 'delivered' ? palette.successSoft : palette.accentSoft }}><Text variant="micro" style={{ color: status === 'delivered' ? palette.success : palette.accent }} weight="bold">{statusLabel(status)}</Text></View>;
}

function nextAction(status: DeliveryStatus): { kind: 'route'; label: string } | { kind: 'progress'; label: string; to: Exclude<DeliveryStatus, 'rider_assigned' | 'delivered'> } | { kind: 'complete'; label: string } | null {
  if (status === 'rider_assigned') return { kind: 'route', label: 'Navigate to pickup' };
  if (status === 'rider_arrived') return { kind: 'progress', label: 'Confirm order picked up', to: 'picked_up' };
  if (status === 'picked_up') return { kind: 'progress', label: 'Start delivery', to: 'en_route' };
  if (status === 'en_route') return { kind: 'route', label: 'Navigate to customer' };
  if (status === 'arrived') return { kind: 'complete', label: 'Enter delivery PIN' };
  return null;
}

function statusLabel(status: DeliveryStatus): string {
  return status === 'rider_assigned' ? 'Heading to pickup' : status === 'rider_arrived' ? 'At pickup' : status === 'picked_up' ? 'Order picked up' : status === 'en_route' ? 'On the way' : status === 'arrived' ? 'At drop-off' : 'Delivered';
}

function metres(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)} km` : `${Math.round(value)} m`;
}

function secondsRemaining(expiresAt?: string): number {
  if (!expiresAt) return 0;
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1_000));
}

function interpolateRoute(start: { latitude: number; longitude: number }, end: { latitude: number; longitude: number }) {
  return Array.from({ length: 6 }, (_, index) => {
    const amount = index / 5;
    return {
      latitude: start.latitude + (end.latitude - start.latitude) * amount + (index === 2 ? 0.0012 : 0),
      longitude: start.longitude + (end.longitude - start.longitude) * amount - (index === 3 ? 0.001 : 0),
    };
  });
}
