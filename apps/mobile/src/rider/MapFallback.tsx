/**
 * What stands in for a map when this build cannot draw one.
 *
 * Two cases: the web design preview, where the native map module does not
 * exist, and a build with no production MapLibre style configured. Neither may
 * pretend to be a map. This draws the rider and the destination — projected
 * from the same coordinates the real map uses — on a plain ground, and says in
 * words what is missing.
 */

import { View } from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';

import type { Coordinate } from '../data/models';
import { useTheme } from '../theme/ThemeProvider';
import { radius, space } from '../theme/tokens';
import { Icon } from '../ui/Icon';
import { Text } from '../ui/Text';

export interface MapShellProps {
  rider: Coordinate;
  destination?: Coordinate;
  /**
   * Draw a dashed straight line from the rider to the destination. It is a
   * direction, not a route: DASH has no routing provider, so it never draws a
   * path that looks like roads. Turn-by-turn belongs to the rider's own
   * navigation app.
   */
  directLine?: boolean;
  /** Keep the viewport centred on a moving rider, used while searching. */
  followRider?: boolean;
  /** Glyph for the destination pin. */
  destinationIcon?: 'silverware-fork-knife' | 'home' | 'storefront-outline';
  /** Pickup pins are bronze and drop-off pins red, matching the stop list. */
  destinationKind?: 'pickup' | 'dropoff';
  routeColor: string;
  /** A fixed height in points, or 'fill' to take all the space it is given. */
  height?: number | 'fill';
  accessibilityLabel: string;
}

export function MapFallback({
  rider,
  destination,
  directLine = false,
  destinationKind = 'pickup',
  routeColor,
  height = 300,
  accessibilityLabel,
  reason,
}: MapShellProps & { reason: string }) {
  const { palette } = useTheme();
  const points = destination ? [rider, destination] : [rider];
  const lats = points.map((p) => p.latitude);
  const lngs = points.map((p) => p.longitude);
  const [minLat, maxLat, minLng, maxLng] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  const W = 320;
  const H = height === 'fill' ? 480 : height;
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
      style={{ ...(height === 'fill' ? { flex: 1 } : { height }), backgroundColor: palette.surfaceMuted, overflow: 'hidden' }}
    >
      <Svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        {directLine && destination ? (
          <Polyline
            points={`${x(rider.longitude)},${y(rider.latitude)} ${x(destination.longitude)},${y(destination.latitude)}`}
            fill="none"
            stroke={routeColor}
            strokeWidth={4}
            strokeDasharray="10 9"
            strokeLinecap="round"
          />
        ) : null}
        <Circle cx={x(rider.longitude)} cy={y(rider.latitude)} r={9} fill={palette.map.riderMarker} stroke="#FFFFFF" strokeWidth={3} />
        {destination ? (
          <Circle
            cx={x(destination.longitude)}
            cy={y(destination.latitude)}
            r={11}
            fill={destinationKind === 'dropoff' ? palette.map.dropoffPin : palette.map.pickupPin}
            stroke="#FFFFFF"
            strokeWidth={3}
          />
        ) : null}
      </Svg>
      <View
        style={{
          position: 'absolute',
          left: space.md,
          bottom: space.md,
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
