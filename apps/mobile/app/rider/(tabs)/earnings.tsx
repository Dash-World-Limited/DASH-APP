/**
 * Earnings — the Rider board, screen 9.
 *
 * STAGING DATA. Rider earnings are not served yet: the ledger can derive them
 * per delivery, but there is no endpoint, so every figure here is sample
 * content — each period has its own sample totals so the switch can be judged.
 * When
 * earnings are wired they come from the server's ledger — never summed on the
 * phone — which is what makes them agree with what DASH actually pays.
 */

import { formatNairaCompact } from '@dash/domain/money';
import { useState } from 'react';
import { View } from 'react-native';

import { SampleDataNote } from '../../../src/commerce/Promotions';
import { RIDER_EARNINGS_BY_PERIOD, RIDER_RECENT_TRIPS } from '../../../src/data/staging';
import { formatRating } from '../../../src/lib/format';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { radius, space } from '../../../src/theme/tokens';
import { Card, Divider, Icon, Screen, SectionHeader, SegmentedControl, Text } from '../../../src/ui';

const PERIODS = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This Week' },
  { value: 'month', label: 'This Month' },
] as const;

export default function Earnings() {
  const { palette } = useTheme();
  const [period, setPeriod] = useState<(typeof PERIODS)[number]['value']>('today');
  const totals = RIDER_EARNINGS_BY_PERIOD[period];

  return (
    <Screen testID="rider-earnings">
      <View style={{ paddingHorizontal: space.gutter, gap: space.lg }}>
        <View style={{ height: 52, alignItems: 'center', justifyContent: 'center' }}>
          <Text variant="appBar" accessibilityRole="header">
            Earnings
          </Text>
        </View>
        <SegmentedControl options={PERIODS} value={period} onChange={setPeriod} accessibilityLabel="Earnings period" />

        <View>
          <Text variant="display">{formatNairaCompact(totals.earnings)}</Text>
          <Text variant="caption" tone="muted">
            {totals.label}
          </Text>
        </View>

        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Stat value={String(totals.trips)} label="Trips" />
          <Stat value={totals.onlineTime} label="Online Time" />
          <Stat value={formatRating(totals.rating)} label="Rating" />
        </View>

        <View>
          <SectionHeader title="Recent Trips" />
          <Card padded={false} style={{ paddingHorizontal: space.lg }}>
            {RIDER_RECENT_TRIPS.map((trip, index) => (
              <View key={trip.id}>
                {index > 0 ? <Divider /> : null}
                <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 52, gap: space.md }}>
                  <View style={{ width: 32, height: 32, borderRadius: radius.sm, backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="silverware-fork-knife" size={16} color={palette.accent} />
                  </View>
                  <Text variant="body" style={{ flex: 1 }} numberOfLines={1}>
                    {trip.merchant}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {trip.time}
                  </Text>
                  <Text variant="label" weight="bold" style={{ minWidth: 64, textAlign: 'right' }}>
                    {formatNairaCompact(trip.earned)}
                  </Text>
                </View>
              </View>
            ))}
          </Card>
        </View>
        <SampleDataNote />
      </View>
    </Screen>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <Card tone="muted" padded={false} style={{ flex: 1, alignItems: 'center', paddingVertical: space.md }}>
      <Text variant="heading">{value}</Text>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
    </Card>
  );
}
