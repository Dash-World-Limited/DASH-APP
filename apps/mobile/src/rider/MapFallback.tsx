/**
 * What stands in for a map when this build cannot draw one.
 *
 * Two cases: the web design preview, where the native map module does not
 * exist, and a build with no production MapLibre style configured. Neither may
 * pretend to be a map. This draws the route's *shape* — projected from the same
 * coordinates the real map will use — on a plain ground, and says in words
 * what is missing.
 */

import { View } from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';

import type { Coordinate } from '../data/models';
import { useTheme } from '../theme/ThemeProvider';
import { radius, space } from '../theme/tokens';
import { Icon } from '../ui/Icon';
import { Text } from '../ui/Text';

export interface MapShellProps {
  route: readonly Coordinate[];
  rider: Coordinate;
  destination?: Coordinate;
  /** Keep the viewport centred on a moving rider, used by the Online screen. */
  followRider?: boolean;
  /** Glyph for the destination pin: the merchant on the way there. */
  destinationIcon?: 'silverware-fork-knife' | 'home' | 'storefront-outline';
  routeColor: string;
  height?: number;
  accessibilityLabel: string;
}

export function MapFallback({ route, rider, destination, routeColor, height = 300, accessibilityLabel, reason }: MapShellProps & { reason: string }) {
  const { palette } = useTheme();
  const points = destination ? [rider, ...route, destination] : [rider, ...route];
  const lats = points.map((p) => p.latitude);
  const lngs = points.map((p) => p.longitude);
  const [minLat, maxLat, minLng, maxLng] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  const W = 320;
  const H = height;
  const pad = 36;
  const x = (lng: number): number =>
    maxLng === minLng ? W / 2 : pad + ((lng - minLng) / (maxLng - minLng)) * (W - pad * 2);
  // Latitude grows northwards; screen y grows downwards.
  const y = (lat: number): number =>
    maxLat === minLat ? H / 2 : pad + ((maxLat - lat) / (maxLat - minLat)) * (H - pad * 2);

  return (
    <View
      accessible
      accessibilityLabel={`${accessibilityLabel}. ${reason}`}
      style={{ height, backgroundColor: palette.surfaceMuted, overflow: 'hidden' }}
    >
      <Svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        <Polyline
          points={route.map((p) => `${x(p.longitude)},${y(p.latitude)}`).join(' ')}
          fill="none"
          stroke={routeColor}
          strokeWidth={5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Circle cx={x(rider.longitude)} cy={y(rider.latitude)} r={9} fill={palette.map.riderMarker} stroke="#FFFFFF" strokeWidth={3} />
        {destination ? (
          <Circle cx={x(destination.longitude)} cy={y(destination.latitude)} r={11} fill={palette.map.pickupPin} stroke="#FFFFFF" strokeWidth={3} />
        ) : null}
      </Svg>
      <View
        style={{
          position: 'absolute',
          left: space.md,
          top: space.md,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingHorizontal: space.sm,
          paddingVertical: 4,
          borderRadius: radius.pill,
          backgroundColor: palette.surface,
        }}
      >
        <Icon name="map-outline" size={14} color={palette.textMuted} />
        <Text variant="micro" tone="muted" weight="medium">
          {reason}
        </Text>
      </View>
    </View>
  );
}
