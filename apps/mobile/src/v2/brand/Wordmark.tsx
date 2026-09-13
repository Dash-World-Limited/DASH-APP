import Svg, { Path, Rect } from 'react-native-svg';

import { useTheme } from '../../theme/ThemeProvider';

/**
 * The DASH wordmark as native vector geometry.
 *
 * This replaces the board crop completely. D and the open A follow the
 * graphite/light side of the approved mark; S, H and the small dash inside A
 * use DASH bronze. Because these are paths, the mark stays sharp at every
 * device density and needs no separate dark-mode bitmap.
 */
export function Wordmark({ height = 25 }: { height?: number }) {
  const { scheme, palette } = useTheme();
  const lead = scheme === 'dark' ? palette.text : '#0B0D10';
  const bronze = palette.accent;

  return (
    <Svg
      width={height * (576 / 156)}
      height={height}
      viewBox="0 0 576 156"
      accessibilityRole="image"
      accessibilityLabel="DASH"
    >
      {/* D */}
      <Path
        fill={lead}
        fillRule="evenodd"
        d="M18 22h66c42 0 67 21 67 56s-25 56-67 56H18V22Zm31 28v56h33c24 0 37-9 37-28S106 50 82 50H49Z"
      />

      {/* Open A: two purpose-drawn legs, no raster tracing or font glyph. */}
      <Path fill={lead} d="M145 134 197 22h28l-46 112h-34Z" />
      <Path fill={lead} d="M211 22h28l52 112h-35L211 22Z" />
      <Rect x="201" y="94" width="28" height="11" rx="5.5" fill={bronze} />

      {/* S */}
      <Path
        fill={bronze}
        d="M302 39c15-13 37-20 67-20 29 0 52 7 69 20l-18 25c-14-10-31-15-50-15-19 0-29 4-29 12 0 7 11 10 34 13 43 6 64 22 64 49 0 30-27 49-72 49-33 0-60-9-78-26l19-25c16 14 37 21 61 21 21 0 32-5 32-14 0-8-11-11-36-15-41-6-61-22-61-48 0-10 3-19 8-26Z"
        transform="translate(0 -17)"
      />

      {/* H */}
      <Path fill={bronze} d="M449 22h31v42h65V22h31v112h-31V92h-65v42h-31V22Z" />
    </Svg>
  );
}
