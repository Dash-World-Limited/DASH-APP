import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { formatNairaCompact, type Kobo } from '@dash/domain/money';

import { api, apiBaseUrl, ApiError } from '../../api';
import { useTheme } from '../../theme/ThemeProvider';
import { declutterHero, radius, space } from '../../theme/tokens';
import { Icon } from '../../ui/Icon';
import { Text } from '../../ui/Text';

interface DeclutterPhoto {
  url: string;
  alt: string;
  role: string;
}

interface DeclutterListingCard {
  slug: string;
  title: string;
  priceKobo: number;
  condition: string;
  categoryKey: string;
  categoryName: string;
  location: { slug: string; label: string };
  availability: string;
  badges: string[];
  photo: DeclutterPhoto | null;
  publishedAt: string | null;
}

interface DeclutterListingDetail extends Omit<DeclutterListingCard, 'photo'> {
  description: string;
  attributes: Record<string, unknown>;
  photos: DeclutterPhoto[];
  seller: {
    id: string;
    displayName: string;
    sellerType: string;
    isTrustedPartner: boolean;
    memberSince: string | null;
  };
  contactable: boolean;
}

type Feed<T> =
  | { status: 'loading' }
  | { status: 'not-connected' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: T };

function mediaUrl(value: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  return apiBaseUrl ? `${apiBaseUrl}${value}` : value;
}

function readable(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function errorMessage(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : 'Could not load Declutters. Please try again.';
}

function BackButton({ onPress }: { onPress: () => void }) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Go back"
      hitSlop={10}
      style={{
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: palette.surface,
        borderWidth: 1,
        borderColor: palette.line,
      }}
    >
      <Icon name="arrow-left" color={palette.text} />
    </Pressable>
  );
}

function LoadingState({ label }: { label: string }) {
  const { palette } = useTheme();
  return (
    <View style={{ minHeight: 240, alignItems: 'center', justifyContent: 'center', gap: space.sm }}>
      <ActivityIndicator color={palette.accent} />
      <Text variant="caption" tone="muted">{label}</Text>
    </View>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { palette } = useTheme();
  return (
    <View style={{ minHeight: 240, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.lg }}>
      <View style={{ width: 70, height: 70, borderRadius: 24, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="alert-circle-outline" size={34} color={palette.accent} />
      </View>
      <Text variant="heading" align="center">Could not load Declutters</Text>
      <Text variant="caption" tone="muted" align="center">{message}</Text>
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        style={{ minHeight: 46, borderRadius: radius.pill, backgroundColor: palette.accent, paddingHorizontal: space.lg, alignItems: 'center', justifyContent: 'center' }}
      >
        <Text variant="label" tone="onAccent" weight="bold">Try again</Text>
      </Pressable>
    </View>
  );
}

export function DeclutterFeedScreen({
  onBack,
  onOpen,
}: {
  onBack: () => void;
  onOpen: (slug: string) => void;
}) {
  const { palette } = useTheme();
  const [state, setState] = useState<Feed<readonly DeclutterListingCard[]>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!api.configured) {
      setState({ status: 'not-connected' });
      return;
    }

    const controller = new AbortController();
    setState({ status: 'loading' });
    api
      .request<{ listings: DeclutterListingCard[] }>('/v1/declutter/listings?sort=newest&limit=40', {
        auth: false,
        signal: controller.signal,
      })
      .then(({ listings }) => setState({ status: 'ready', data: listings }))
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', message: errorMessage(caught) });
      });

    return () => controller.abort();
  }, [attempt]);

  const listings = state.status === 'ready' ? state.data : [];

  return (
    <ScrollView
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, gap: space.lg }}
      style={{ flex: 1, backgroundColor: palette.background }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <BackButton onPress={onBack} />
        <View style={{ flex: 1 }}>
          <Text variant="title">Declutter</Text>
          <Text variant="caption" tone="muted">Verified pre-owned finds from DASH Declutters.</Text>
        </View>
      </View>

      <View style={{ minHeight: 132, borderRadius: radius.xl, padding: space.lg, overflow: 'hidden', backgroundColor: declutterHero.background, justifyContent: 'center' }}>
        <View style={{ position: 'absolute', width: 150, height: 150, borderRadius: 75, right: -28, top: -12, backgroundColor: 'rgba(255,255,255,0.52)' }} />
        <Text variant="title" style={{ color: declutterHero.title, maxWidth: '70%' }}>Good items deserve another life.</Text>
        <Text variant="caption" style={{ color: declutterHero.caption, maxWidth: '72%', marginTop: space.sm }}>
          Listings shown here have passed the DASH publication flow.
        </Text>
      </View>

      {state.status === 'loading' ? <LoadingState label="Loading listings…" /> : null}
      {state.status === 'not-connected' ? (
        <ErrorState message="This build is not connected to the DASH API." onRetry={() => setAttempt((value) => value + 1)} />
      ) : null}
      {state.status === 'error' ? <ErrorState message={state.message} onRetry={() => setAttempt((value) => value + 1)} /> : null}

      {state.status === 'ready' && listings.length === 0 ? (
        <View style={{ minHeight: 240, alignItems: 'center', justifyContent: 'center', gap: space.sm, padding: space.lg }}>
          <View style={{ width: 70, height: 70, borderRadius: 24, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="package-variant-closed" size={34} color={palette.accent} />
          </View>
          <Text variant="heading" align="center">No live listings yet</Text>
          <Text variant="caption" tone="muted" align="center">Approved seller items will appear here automatically as they are published.</Text>
        </View>
      ) : null}

      {state.status === 'ready' && listings.length > 0 ? (
        <View style={{ gap: space.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text variant="heading">Latest finds</Text>
            <Text variant="micro" tone="muted">{listings.length} shown</Text>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
            {listings.map((listing) => (
              <Pressable
                key={listing.slug}
                onPress={() => onOpen(listing.slug)}
                accessibilityRole="button"
                accessibilityLabel={`Open ${listing.title}`}
                style={({ pressed }) => ({
                  width: '47.8%',
                  borderRadius: radius.lg,
                  overflow: 'hidden',
                  backgroundColor: pressed ? palette.sand : palette.surface,
                  borderWidth: 1,
                  borderColor: palette.line,
                })}
              >
                <View style={{ height: 158, backgroundColor: palette.surfaceMuted }}>
                  {listing.photo ? (
                    <Image
                      source={{ uri: mediaUrl(listing.photo.url) }}
                      accessibilityLabel={listing.photo.alt}
                      style={{ width: '100%', height: '100%' }}
                      contentFit="cover"
                    />
                  ) : (
                    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                      <Icon name="image-outline" size={34} color={palette.textSubtle} />
                    </View>
                  )}
                  <View style={{ position: 'absolute', left: space.sm, top: space.sm, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.94)', paddingHorizontal: space.sm, paddingVertical: 4 }}>
                    <Text variant="micro" weight="bold">{readable(listing.condition)}</Text>
                  </View>
                </View>
                <View style={{ padding: space.md, gap: 4 }}>
                  <Text variant="label" weight="bold" numberOfLines={2}>{listing.title}</Text>
                  <Text variant="caption" tone="accent" weight="bold">{formatNairaCompact(listing.priceKobo as Kobo)}</Text>
                  <Text variant="micro" tone="muted" numberOfLines={1}>{listing.location.label}</Text>
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

export function DeclutterListingScreen({ slug, onBack }: { slug: string; onBack: () => void }) {
  const { palette } = useTheme();
  const [state, setState] = useState<Feed<DeclutterListingDetail>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!api.configured) {
      setState({ status: 'not-connected' });
      return;
    }
    if (!slug) {
      setState({ status: 'error', message: 'No listing was selected.' });
      return;
    }

    const controller = new AbortController();
    setState({ status: 'loading' });
    api
      .request<{ listing: DeclutterListingDetail }>(`/v1/declutter/listings/${encodeURIComponent(slug)}`, {
        auth: false,
        signal: controller.signal,
      })
      .then(({ listing }) => setState({ status: 'ready', data: listing }))
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', message: errorMessage(caught) });
      });

    return () => controller.abort();
  }, [attempt, slug]);

  if (state.status === 'loading') {
    return (
      <View style={{ flex: 1, backgroundColor: palette.background, padding: space.lg }}>
        <BackButton onPress={onBack} />
        <LoadingState label="Loading item…" />
      </View>
    );
  }

  if (state.status === 'not-connected' || state.status === 'error') {
    return (
      <View style={{ flex: 1, backgroundColor: palette.background, padding: space.lg }}>
        <BackButton onPress={onBack} />
        <ErrorState
          message={state.status === 'error' ? state.message : 'This build is not connected to the DASH API.'}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      </View>
    );
  }

  const listing = state.data;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.background }}
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, gap: space.lg }}
    >
      <BackButton onPress={onBack} />

      {listing.photos[0] ? (
        <Image
          source={{ uri: mediaUrl(listing.photos[0].url) }}
          accessibilityLabel={listing.photos[0].alt}
          style={{ width: '100%', aspectRatio: 1, borderRadius: radius.xl, backgroundColor: palette.surfaceMuted }}
          contentFit="cover"
        />
      ) : (
        <View style={{ width: '100%', aspectRatio: 1, borderRadius: radius.xl, backgroundColor: palette.surfaceMuted, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="image-outline" size={52} color={palette.textSubtle} />
        </View>
      )}

      {listing.photos.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
          {listing.photos.slice(1).map((photo, index) => (
            <Image
              key={`${photo.url}-${index}`}
              source={{ uri: mediaUrl(photo.url) }}
              accessibilityLabel={photo.alt}
              style={{ width: 92, height: 92, borderRadius: radius.md, backgroundColor: palette.surfaceMuted }}
              contentFit="cover"
            />
          ))}
        </ScrollView>
      ) : null}

      <View style={{ gap: space.sm }}>
        <Text variant="display">{listing.title}</Text>
        <Text variant="title" tone="accent">{formatNairaCompact(listing.priceKobo as Kobo)}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          <View style={{ borderRadius: radius.pill, backgroundColor: palette.accentSoft, paddingHorizontal: space.md, paddingVertical: 6 }}>
            <Text variant="micro" tone="accent" weight="bold">{readable(listing.condition)}</Text>
          </View>
          <View style={{ borderRadius: radius.pill, backgroundColor: palette.surfaceMuted, paddingHorizontal: space.md, paddingVertical: 6 }}>
            <Text variant="micro" weight="bold">{listing.categoryName}</Text>
          </View>
        </View>
      </View>

      <View style={{ borderRadius: radius.lg, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, padding: space.lg, gap: space.sm }}>
        <Text variant="heading">About this item</Text>
        <Text variant="body">{listing.description}</Text>
        <Text variant="caption" tone="muted">{listing.location.label}</Text>
      </View>

      <View style={{ borderRadius: radius.lg, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, padding: space.lg, gap: space.sm }}>
        <Text variant="heading">Seller</Text>
        <Text variant="bodyStrong">{listing.seller.displayName}</Text>
        <Text variant="caption" tone="muted">
          {listing.seller.isTrustedPartner ? 'DASH Trusted Partner' : 'Verified Declutters seller'}
        </Text>
      </View>

      {listing.badges.length > 0 ? (
        <View style={{ gap: space.sm }}>
          <Text variant="heading">DASH checks</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {listing.badges.map((badge) => (
              <View key={badge} style={{ borderRadius: radius.pill, backgroundColor: palette.accentSoft, paddingHorizontal: space.md, paddingVertical: 7 }}>
                <Text variant="micro" tone="accent" weight="bold">{readable(badge)}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      <View style={{ borderRadius: radius.lg, backgroundColor: palette.surfaceMuted, padding: space.lg }}>
        <Text variant="caption" tone="muted">
          Buying/contact flow remains mediated by DASH. Seller phone numbers are never exposed in the listing.
        </Text>
      </View>
    </ScrollView>
  );
}
