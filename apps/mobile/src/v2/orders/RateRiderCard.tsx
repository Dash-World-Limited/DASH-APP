/**
 * Rating the rider who delivered an order: one to five stars and an optional
 * comment, once. Shown on a delivered order; the server decides which rider it
 * is for and refuses a second rating.
 */

import { useRef, useState } from 'react';
import { Pressable, View } from 'react-native';

import { api, ApiError } from '../../api';
import { rateRider, type RiderRating, type RiderRatingState } from '../../data/orders';
import { RATING_STARS, ratingWord } from '../../features/delivery';
import { useTheme } from '../../theme/ThemeProvider';
import { space, touchTarget } from '../../theme/tokens';
import { TextField } from '../../ui/Fields';
import { Icon } from '../../ui/Icon';
import { Text } from '../../ui/Text';
import { Card, Notice, PrimaryCheckoutButton } from './parts';

const COMMENT_MAX = 500;

export function RateRiderCard({ orderId, state }: { orderId: string; state: RiderRatingState }) {
  const { palette } = useTheme();
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [given, setGiven] = useState<RiderRating | null>(state.rating);
  const sending = useRef(false);
  const name = state.riderName ?? 'your rider';

  const submit = async () => {
    if (sending.current || stars < 1) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      setGiven(await rateRider(api, orderId, { rating: stars, comment }));
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.isNetwork
            ? 'DASH could not be reached. Check your connection and try again.'
            : caught.message
          : 'Your rating could not be sent. Please try again.',
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  if (given) {
    return (
      <Card>
        <Text variant="label" weight="bold">You rated {name}</Text>
        <StarRow value={given.rating} />
        <Text variant="caption" tone="muted">{ratingWord(given.rating)}{given.comment ? ` · “${given.comment}”` : ''}</Text>
        <Text variant="micro" tone="muted">Thank you. Your rating helps DASH keep deliveries good.</Text>
      </Card>
    );
  }

  if (!state.canRate) return null;

  return (
    <Card>
      <Text variant="label" weight="bold">How was your delivery with {name}?</Text>
      <StarRow value={stars} onChange={busy ? undefined : setStars} />
      <Text variant="caption" tone={stars ? 'default' : 'muted'}>{stars ? ratingWord(stars) : 'Tap a star to rate'}</Text>
      {stars ? (
        <TextField
          label="Add a comment (optional)"
          value={comment}
          onChangeText={setComment}
          placeholder="What went well, or what could be better?"
          maxLength={COMMENT_MAX}
          multiline
          numberOfLines={3}
          editable={!busy}
          hint={`${comment.length}/${COMMENT_MAX}`}
          testID="rate-rider-comment"
        />
      ) : null}
      {error ? <Notice icon="alert-circle-outline" text={error} danger /> : null}
      <PrimaryCheckoutButton label={busy ? 'Sending…' : 'Submit rating'} onPress={() => void submit()} disabled={busy || stars < 1} busy={busy} />
      <Text variant="micro" tone="muted" style={{ color: palette.textMuted }}>You can rate each delivery once.</Text>
    </Card>
  );
}

function StarRow({ value, onChange }: { value: number; onChange?: ((stars: number) => void) | undefined }) {
  const { palette } = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: space.xs }} accessibilityRole={onChange ? 'radiogroup' : undefined} accessibilityLabel={onChange ? 'Rating' : `${value} out of 5 stars`}>
      {RATING_STARS.map((star) => {
        const filled = star <= value;
        const icon = <Icon name={filled ? 'star' : 'star-outline'} size={32} color={filled ? palette.accent : palette.textSubtle} />;
        return onChange ? (
          <Pressable
            key={star}
            onPress={() => onChange(star)}
            accessibilityRole="radio"
            accessibilityState={{ selected: star === value }}
            accessibilityLabel={`${star} ${star === 1 ? 'star' : 'stars'}, ${ratingWord(star)}`}
            hitSlop={4}
            style={{ minWidth: touchTarget, minHeight: touchTarget, alignItems: 'center', justifyContent: 'center' }}
            testID={`rate-rider-star-${star}`}
          >
            {icon}
          </Pressable>
        ) : (
          <View key={star}>{icon}</View>
        );
      })}
    </View>
  );
}
