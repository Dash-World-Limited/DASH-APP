/**
 * The pieces the customer order screens share — the page, its header, and the
 * four things every one of them needs to say something.
 *
 * They lived inside CustomerOrderScreens until checkout grew into its own
 * file and needed the same shapes. Nothing here knows about orders; it is
 * v2's surface vocabulary, kept in one place so two screens cannot drift into
 * two slightly different cards.
 */

import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';

import { useTheme } from '../../theme/ThemeProvider';
import { radius, space, touchTarget } from '../../theme/tokens';
import { Icon, type IconName } from '../../ui/Icon';
import { Text } from '../../ui/Text';

export function OrderPage({ children, testID }: { children: ReactNode; testID?: string }) {
  const { palette } = useTheme();
  return <ScrollView testID={testID} style={{ flex: 1, backgroundColor: palette.background }} contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.xxxl, gap: space.lg }} showsVerticalScrollIndicator={false}>{children}</ScrollView>;
}

export function BackHeader({ title, onBack }: { title: string; onBack: () => void }) {
  const { palette } = useTheme();
  return <View style={{ minHeight: 54, flexDirection: 'row', alignItems: 'center' }}><Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Go back" style={{ width: touchTarget, height: touchTarget, alignItems: 'center', justifyContent: 'center' }}><Icon name="arrow-left" color={palette.text} /></Pressable><Text variant="appBar">{title}</Text></View>;
}

export function Card({ children }: { children: ReactNode }) {
  const { palette } = useTheme();
  return <View style={{ padding: space.lg, gap: space.md, borderRadius: radius.lg, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line }}>{children}</View>;
}

export function Notice({ icon, text, danger = false }: { icon: IconName; text: string; danger?: boolean }) {
  const { palette } = useTheme();
  return <View style={{ flexDirection: 'row', gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: danger ? palette.dangerSoft : palette.accentSoft }}><Icon name={icon} color={danger ? palette.danger : palette.accent} /><Text variant="caption" style={{ flex: 1, color: danger ? palette.danger : palette.text }}>{text}</Text></View>;
}

export function Empty({ icon, title, body, action, onPress }: { icon: IconName; title: string; body: string; action?: string; onPress?: () => void }) {
  const { palette } = useTheme();
  return <View style={{ minHeight: 250, alignItems: 'center', justifyContent: 'center', gap: space.sm, padding: space.xl }}><View style={{ width: 68, height: 68, borderRadius: 22, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size={32} color={palette.accent} /></View><Text variant="heading" align="center">{title}</Text><Text variant="caption" tone="muted" align="center">{body}</Text>{action && onPress ? <Pressable onPress={onPress} accessibilityRole="button" style={{ minHeight: 46, justifyContent: 'center', paddingHorizontal: space.xl, borderRadius: radius.md, backgroundColor: palette.accent }}><Text variant="caption" tone="onAccent" weight="bold">{action}</Text></Pressable> : null}</View>;
}

export function PrimaryCheckoutButton({ label, onPress, disabled = false, busy = false }: { label: string; onPress: () => void; disabled?: boolean; busy?: boolean }) {
  const { palette } = useTheme();
  return <Pressable disabled={disabled} onPress={onPress} accessibilityRole="button" accessibilityState={{ disabled }} style={({ pressed }) => ({ minHeight: 52, borderRadius: radius.md, opacity: disabled ? 0.55 : 1, backgroundColor: pressed ? palette.accentPressed : palette.accent, flexDirection: 'row', gap: space.sm, alignItems: 'center', justifyContent: 'center' })}>{busy ? <ActivityIndicator color={palette.onAccent} /> : null}<Text variant="label" tone="onAccent" weight="bold">{label}</Text></Pressable>;
}

export function SecondaryButton({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  const { palette } = useTheme();
  return <Pressable disabled={disabled} onPress={onPress} accessibilityRole="button" accessibilityState={{ disabled }} style={({ pressed }) => ({ minHeight: 50, borderRadius: radius.md, opacity: disabled ? 0.55 : 1, backgroundColor: pressed ? palette.surfaceMuted : palette.surface, borderWidth: 1, borderColor: palette.line, alignItems: 'center', justifyContent: 'center' })}><Text variant="caption" weight="bold">{label}</Text></Pressable>;
}
