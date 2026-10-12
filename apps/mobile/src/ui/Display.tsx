/**
 * Things that show state rather than take input: status pills, avatars,
 * settings rows, section headers, skeletons, and the empty, error and offline
 * states every data screen needs.
 *
 * The states are designed, not afterthoughts. An empty state says what to do
 * next; an error state carries the request reference, because that is the only
 * thing that connects what someone saw on their phone to what the server
 * logged.
 */

import { Image } from 'expo-image';
import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Pressable, View, type ImageSourcePropType, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { radius, space, touchTarget } from '../theme/tokens';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export function StatusPill({
  label,
  tone = 'success',
  dot = true,
}: {
  label: string;
  tone?: 'success' | 'accent' | 'danger' | 'neutral';
  dot?: boolean;
}) {
  const { palette } = useTheme();
  const fg = tone === 'success' ? palette.success : tone === 'accent' ? palette.accent : tone === 'danger' ? palette.danger : palette.textMuted;
  const bg = tone === 'success' ? palette.successSoft : tone === 'accent' ? palette.accentSoft : tone === 'danger' ? palette.dangerSoft : palette.sand;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: 6,
        paddingHorizontal: space.sm + 2,
        paddingVertical: 4,
        borderRadius: radius.pill,
        backgroundColor: bg,
      }}
    >
      {dot ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: fg }} /> : null}
      <Text variant="micro" style={{ color: fg }}>
        {label}
      </Text>
    </View>
  );
}

/** A person or a merchant. Photograph when there is one, initials when not. */
export function Avatar({
  source,
  name,
  size = 44,
  ring = false,
}: {
  source?: ImageSourcePropType | null;
  name: string;
  size?: number;
  /** A white ring, for avatars that overlap photography. */
  ring?: boolean;
}) {
  const { palette } = useTheme();
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <View
      accessibilityLabel={name}
      accessible
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        overflow: 'hidden',
        backgroundColor: palette.sand,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: ring ? 3 : 0,
        borderColor: palette.surface,
      }}
    >
      {source ? (
        <Image source={source} style={{ width: '100%', height: '100%' }} contentFit="cover" />
      ) : (
        <Text variant="label" tone="muted">
          {initials}
        </Text>
      )}
    </View>
  );
}

/** "Featured Shops ··· See All". */
export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.md }}>
      <Text variant="heading" accessibilityRole="header">
        {title}
      </Text>
      {action && onAction ? (
        <Pressable onPress={onAction} accessibilityRole="link" hitSlop={10}>
          <Text variant="label" tone="accent">
            {action}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A settings row: icon, label, optional value or control, chevron. */
export function ListRow({
  icon,
  label,
  value,
  trailing,
  onPress,
  tone = 'default',
}: {
  icon: IconName;
  label: string;
  value?: string;
  /** A control in place of the chevron — the Appearance switch, a badge. */
  trailing?: ReactNode;
  onPress?: () => void;
  tone?: 'default' | 'danger';
}) {
  const { palette } = useTheme();
  const color = tone === 'danger' ? palette.danger : palette.text;
  const content = (
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: touchTarget + 8, gap: space.md }}>
      <Icon name={icon} size={22} color={color} />
      <Text variant="body" style={{ flex: 1, color }}>
        {label}
      </Text>
      {value ? (
        <Text variant="caption" tone="muted">
          {value}
        </Text>
      ) : null}
      {trailing ?? (onPress && tone !== 'danger' ? <Icon name="chevron-right" size={22} color={palette.textSubtle} /> : null)}
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={value ? `${label}, ${value}` : label}>
      {({ pressed }) => <View style={{ opacity: pressed ? 0.6 : 1 }}>{content}</View>}
    </Pressable>
  );
}

/**
 * A loading placeholder shaped like the thing it stands in for. It pulses
 * gently rather than shimmering — cheaper on a mid-range Android, and calmer.
 */
export function Skeleton({ style }: { style?: StyleProp<ViewStyle> }) {
  const { palette } = useTheme();
  const pulse = useRef(new Animated.Value(0.55)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.55, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ backgroundColor: palette.sand, borderRadius: radius.md, opacity: pulse }, style]}
    />
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
  onAction,
}: {
  icon: IconName;
  title: string;
  body: string;
  action?: string;
  onAction?: () => void;
}) {
  const { palette } = useTheme();
  return (
    <View style={{ alignItems: 'center', paddingVertical: space.xxxl, paddingHorizontal: space.xl, gap: space.md }}>
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: 32,
          backgroundColor: palette.accentSoft,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name={icon} size={30} color={palette.accent} />
      </View>
      <Text variant="heading" align="center">
        {title}
      </Text>
      <Text variant="body" tone="muted" align="center">
        {body}
      </Text>
      {action && onAction ? <Button label={action} variant="secondary" size="md" onPress={onAction} /> : null}
    </View>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  reference,
  onRetry,
}: {
  title?: string;
  message: string;
  /** The server's request id, when there is one. */
  reference?: string | null;
  onRetry?: () => void;
}) {
  const { palette } = useTheme();
  return (
    <View
      accessibilityRole="alert"
      style={{ padding: space.lg, borderRadius: radius.lg, backgroundColor: palette.dangerSoft, gap: space.sm }}
    >
      <Text variant="bodyStrong" tone="danger">
        {title}
      </Text>
      <Text variant="caption" tone="muted">
        {message}
      </Text>
      {reference ? (
        <Text variant="micro" tone="subtle" selectable>
          Reference: {reference}
        </Text>
      ) : null}
      {onRetry ? <Button label="Try again" variant="outline" size="md" onPress={onRetry} style={{ alignSelf: 'flex-start' }} /> : null}
    </View>
  );
}

/** A thin strip saying the phone is offline, and that what is shown may be stale. */
export function OfflineBanner() {
  const { palette } = useTheme();
  return (
    <View
      accessibilityRole="alert"
      style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md, backgroundColor: palette.sand }}
    >
      <Icon name="wifi-off" size={18} color={palette.textMuted} />
      <Text variant="caption" tone="muted">
        You are offline. What you see may be out of date.
      </Text>
    </View>
  );
}
