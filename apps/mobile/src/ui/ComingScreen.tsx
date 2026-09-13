/**
 * A designed destination for a flow that is not built yet.
 *
 * Every tap in the app must land somewhere real. Where the flow behind it
 * belongs to a later checkpoint, this says so plainly — what it will do, and
 * what it is waiting on — instead of a dead control or an imitation of the
 * feature. Honest pre-release, not a placeholder that looks like a bug.
 */

import type { ImageSourcePropType } from 'react-native';
import { View } from 'react-native';
import { Image } from 'expo-image';

import { useTheme } from '../theme/ThemeProvider';
import { radius, space } from '../theme/tokens';
import { AppBar } from './AppBar';
import { Icon, type IconName } from './Icon';
import { Screen } from './Surfaces';
import { Text } from './Text';

export function ComingScreen({
  title,
  headline,
  body,
  waitingOn,
  icon = 'progress-clock',
  art,
  back = true,
}: {
  title: string;
  headline: string;
  body: string;
  /** What has to exist first — a checkpoint, a backend capability, a decision. */
  waitingOn: string;
  icon?: IconName;
  art?: ImageSourcePropType;
  back?: boolean;
}) {
  const { palette } = useTheme();
  return (
    <Screen>
      <AppBar title={title} back={back} />
      <View style={{ paddingHorizontal: space.gutter, paddingTop: space.xxl, alignItems: 'center', gap: space.lg }}>
        {art ? (
          <Image source={art} style={{ width: 150, height: 120 }} contentFit="contain" />
        ) : (
          <View
            style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name={icon} size={34} color={palette.accent} />
          </View>
        )}
        <Text variant="title" align="center">
          {headline}
        </Text>
        <Text variant="body" tone="muted" align="center">
          {body}
        </Text>
        <View
          style={{
            flexDirection: 'row',
            gap: space.sm,
            padding: space.md,
            borderRadius: radius.md,
            backgroundColor: palette.sand,
            alignSelf: 'stretch',
          }}
        >
          <Icon name="information-outline" size={18} color={palette.textMuted} />
          <Text variant="caption" tone="muted" style={{ flex: 1 }}>
            {waitingOn}
          </Text>
        </View>
      </View>
    </Screen>
  );
}
