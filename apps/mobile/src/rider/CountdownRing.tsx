/**
 * The offer clock: a bronze ring that empties, and the seconds left inside it.
 *
 * Driven by the server's `expiresAt` through `features/offer`, not by a timer
 * that started when the screen opened — see that module for why. It ticks four
 * times a second so the ring moves smoothly, and announces the time to screen
 * readers only when the whole-second value changes, so VoiceOver is not
 * reading numbers at someone continuously.
 */

import { useEffect, useState } from 'react';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { remainingFraction, secondsLeft } from '../features/offer';
import { useTheme } from '../theme/ThemeProvider';
import { Text } from '../ui/Text';

export function CountdownRing({
  expiresAt,
  windowSeconds,
  size = 84,
  onExpire,
}: {
  expiresAt: string;
  windowSeconds: number;
  size?: number;
  onExpire?: () => void;
}) {
  const { palette } = useTheme();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  const seconds = secondsLeft(expiresAt, now);
  const fraction = remainingFraction(expiresAt, windowSeconds, now);

  useEffect(() => {
    if (seconds === 0) onExpire?.();
  }, [seconds, onExpire]);

  const stroke = 5;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;

  return (
    <View
      accessible
      accessibilityRole="timer"
      accessibilityLabel={`${seconds} seconds left to accept`}
      accessibilityLiveRegion="polite"
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
    >
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={palette.line} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={palette.accent}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={circumference * (1 - fraction)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <Text variant="title" weight="extrabold">
        {seconds}
      </Text>
    </View>
  );
}
