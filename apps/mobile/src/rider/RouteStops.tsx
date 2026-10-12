/**
 * Pickup, then drop-off, joined by a line — the stop list on the Incoming
 * Order and Order Details boards. Green disc for the pickup, red pin for the
 * drop-off, so the two are told apart by shape as well as colour.
 */

import { View } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { space } from '../theme/tokens';
import { Icon } from '../ui/Icon';
import { Text } from '../ui/Text';

export interface Stop {
  title: string;
  detail?: string | null;
}

export function RouteStops({ pickup, dropoff }: { pickup: Stop; dropoff: Stop }) {
  const { palette } = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: space.md }}>
      <View style={{ alignItems: 'center', width: 22, paddingTop: 2 }}>
        <View
          style={{
            width: 18,
            height: 18,
            borderRadius: 9,
            backgroundColor: palette.success,
            borderWidth: 4,
            borderColor: palette.successSoft,
          }}
        />
        <View style={{ flex: 1, width: 2, backgroundColor: palette.success, marginVertical: 2, minHeight: 22 }} />
        <Icon name="map-marker" size={24} color={palette.map.dropoffPin} />
      </View>
      <View style={{ flex: 1, gap: space.lg }}>
        <StopText label="Pickup" stop={pickup} />
        <StopText label="Dropoff" stop={dropoff} />
      </View>
    </View>
  );
}

function StopText({ label, stop }: { label: string; stop: Stop }) {
  return (
    <View accessible accessibilityLabel={`${label}: ${stop.title}${stop.detail ? `, ${stop.detail}` : ''}`}>
      <Text variant="micro" tone="muted" weight="medium">
        {label}
      </Text>
      <Text variant="label" weight="bold">
        {stop.title}
      </Text>
      {stop.detail ? (
        <Text variant="caption" tone="muted">
          {stop.detail}
        </Text>
      ) : null}
    </View>
  );
}
