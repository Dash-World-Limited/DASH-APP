/**
 * Campaign cards, a shared category bubble, and the sample-data note.
 *
 * A promotion is campaign content — PRODUCT_FOUNDATION is explicit that the
 * hero is not the permanent navigation — so its ground and ink come with the
 * campaign, not from the theme. The frame is DASH's: title, a line, one
 * action, one photograph on the right, fading into the card rather than boxed
 * inside it.
 */

import { Image } from 'expo-image';
import { Pressable, View, type ImageSourcePropType } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { palettes, radius, space } from '../theme/tokens';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Text } from '../ui/Text';

export interface Campaign {
  title: string;
  body: string;
  action?: string;
  image: ImageSourcePropType;
  ground: string;
  ink: string;
}

export function PromoCard({ campaign, onPress, height = 196 }: { campaign: Campaign; onPress: () => void; height?: number }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${campaign.title.replace(/\n/g, ' ')}. ${campaign.body}`}
      accessibilityHint={campaign.action}
      style={({ pressed }) => ({
        height,
        borderRadius: radius.lg,
        backgroundColor: campaign.ground,
        overflow: 'hidden',
        transform: [{ scale: pressed ? 0.99 : 1 }],
      })}
    >
      <Image
        source={campaign.image}
        style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: '52%' }}
        contentFit="cover"
      />
      <View style={{ padding: space.lg, paddingRight: '44%', flex: 1, justifyContent: 'space-between' }}>
        <View style={{ gap: space.xs }}>
          <Text variant="title" style={{ color: campaign.ink }}>
            {campaign.title}
          </Text>
          <Text variant="caption" style={{ color: campaign.ink, opacity: 0.75 }}>
            {campaign.body}
          </Text>
        </View>
        {campaign.action ? (
          <Button
            label={campaign.action}
            variant="inverse"
            // Campaign art is drawn on the Light board and keeps its colours in
            // Dark, so its call to action keeps the board's graphite pill too.
            colors={{ bg: palettes.light.inverse, fg: palettes.light.textOnInverse }}
            size="md"
            pill
            trailingIcon="arrow-right"
            decorative
            style={{ alignSelf: 'flex-start', minHeight: 38 }}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

/** A round category door above a service's merchants: image or the "All" grid. */
export function CategoryBubble({
  label,
  image,
  selected,
  onPress,
}: {
  label: string;
  image: ImageSourcePropType | null;
  selected: boolean;
  onPress: () => void;
}) {
  const { palette } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      style={{ alignItems: 'center', width: 76, gap: space.xs }}
    >
      <View
        style={{
          width: 58,
          height: 58,
          borderRadius: 29,
          overflow: 'hidden',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: selected ? palette.accent : palette.sand,
          borderWidth: selected ? 0 : 1,
          borderColor: palette.edge,
        }}
      >
        {image ? (
          <Image source={image} style={{ width: '100%', height: '100%' }} contentFit="cover" />
        ) : (
          <Icon name="view-grid-outline" size={24} color={selected ? palette.onAccent : palette.text} />
        )}
      </View>
      <Text variant="micro" weight={selected ? 'bold' : 'medium'} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The line at the foot of a screen drawn from staging fixtures.
 *
 * Quiet, but always there: prices, ratings and delivery times on these screens
 * are sample content, and a person reviewing a pre-release build should never
 * have to wonder whether "4.8 (1.2k)" is a real shop's rating.
 */
export function SampleDataNote() {
  const { palette } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: space.lg }}>
      <Icon name="flask-outline" size={14} color={palette.textSubtle} />
      <Text variant="micro" tone="subtle" weight="medium">
        Staging sample data — not live prices or ratings
      </Text>
    </View>
  );
}
