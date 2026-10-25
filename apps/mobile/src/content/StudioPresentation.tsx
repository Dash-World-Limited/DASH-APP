import { useState, type ReactNode } from 'react';
import { Pressable, View, type ImageStyle, type StyleProp } from 'react-native';
import { Image } from 'expo-image';
import type { PublicContentItem } from '@dash/domain/content';
import { studioSlot } from '@dash/domain/content/presentation';
import { useTheme } from '../theme/ThemeProvider';
import { Text } from '../ui/Text';
import { radius, space } from '../theme/tokens';
import type { AppRoute } from '../v2/navigation/model';

export function studioRoute(href: string | null): AppRoute | null {
  if (href === '/home') return { name: 'customer.home' };
  const service = (
    {
      '/restaurants': 'food',
      '/shops': 'shops',
      '/market': 'local-market',
      '/pharmacy': 'pharmacy',
      '/declutter': 'declutter',
    } as Record<string, string>
  )[href ?? ''];
  if (service) return { name: 'customer.category', params: { id: service } };
  if (href && /^\/browse\/[a-z0-9-]+$/.test(href))
    return {
      name: 'customer.store',
      params: { category: 'shops', id: href.slice('/browse/'.length) },
    };
  return null;
}
export function StudioImage({
  image,
  style,
  fallback = null,
}: {
  image: PublicContentItem['image'];
  style: StyleProp<ImageStyle>;
  fallback?: ReactNode;
}) {
  return image ? (
    <RemoteImage
      key={image.url}
      image={image}
      style={style}
      fallback={fallback}
    />
  ) : (
    <>{fallback}</>
  );
}
function RemoteImage({
  image,
  style,
  fallback,
}: {
  image: NonNullable<PublicContentItem['image']>;
  style: StyleProp<ImageStyle>;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <>{fallback}</>
  ) : (
    <Image
      source={{ uri: image.url }}
      accessibilityLabel={image.alt}
      style={style}
      contentFit="cover"
      onError={() => setFailed(true)}
    />
  );
}
function Promotion({
  item,
  onPush,
  fallback,
}: {
  item: PublicContentItem;
  onPush: (route: AppRoute) => void;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const { palette } = useTheme();
  if (!item.image || failed) return <>{fallback}</>;
  const route = studioRoute(item.href);
  return (
    <Pressable
      accessibilityRole={route ? 'button' : undefined}
      accessibilityLabel={item.title}
      disabled={!route}
      onPress={() => route && onPush(route)}
      style={{
        borderRadius: radius.xl,
        overflow: 'hidden',
        backgroundColor: palette.surface,
        borderWidth: 1,
        borderColor: palette.line,
      }}
    >
      <Image
        source={{ uri: item.image.url }}
        accessibilityLabel={item.image.alt}
        style={{ width: '100%', height: 154 }}
        contentFit="cover"
        onError={() => setFailed(true)}
      />
      <View style={{ padding: space.lg, gap: space.xs }}>
        <Text variant="heading">{item.title}</Text>
        {item.body ? (
          <Text variant="caption" tone="muted">
            {item.body}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
export function StudioHero({
  items,
  onPush,
  fallback,
}: {
  items: readonly PublicContentItem[];
  onPush: (route: AppRoute) => void;
  fallback: ReactNode;
}) {
  const hero = studioSlot(items, 'home.hero').find((item) => item.image);
  return hero ? (
    <Promotion
      key={`${hero.id}:${hero.revision}:${hero.image?.url}`}
      item={hero}
      onPush={onPush}
      fallback={fallback}
    />
  ) : (
    <>{fallback}</>
  );
}
export function StudioDiscovery({
  items,
  onPush,
}: {
  items: readonly PublicContentItem[];
  onPush: (route: AppRoute) => void;
}) {
  const { palette } = useTheme();
  const cards = [
    ...studioSlot(items, 'home.promotions'),
    ...studioSlot(items, 'home.featured').filter(
      (item) => item.type === 'collection',
    ),
  ].slice(0, 4);
  return (
    <>
      {studioSlot(items, 'home.announcements')
        .slice(0, 2)
        .map((item) => (
          <View
            key={item.id}
            style={{
              padding: space.md,
              borderRadius: radius.md,
              backgroundColor: palette.surface,
            }}
          >
            <Text variant="label" weight="bold">
              {item.title}
            </Text>
            <Text variant="caption" tone="muted">
              {item.body}
            </Text>
          </View>
        ))}
      {cards.map((item) => (
        <Promotion
          key={`${item.id}:${item.revision}`}
          item={item}
          onPush={onPush}
          fallback={null}
        />
      ))}
    </>
  );
}
export function StudioVendorLabel({
  label,
  featured,
}: {
  label?: string;
  featured?: boolean;
}) {
  const { palette } = useTheme();
  return label || featured ? (
    <Text variant="micro" style={{ color: palette.accent }}>
      {label || 'Featured by DASH'}
    </Text>
  ) : null;
}
