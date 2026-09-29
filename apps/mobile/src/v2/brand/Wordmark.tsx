import Svg, { Path } from 'react-native-svg';

import { useTheme } from '../../theme/ThemeProvider';

/**
 * The DASH wordmark as native vector geometry.
 *
 * This replaces the board crop completely. D and the open A follow the
 * graphite/light side of the approved mark; S and H use DASH bronze. Because
 * these are paths, the mark stays sharp at every
 * device density and needs no separate dark-mode bitmap.
 */
export function Wordmark({ height = 25 }: { height?: number }) {
  const { scheme, palette } = useTheme();
  const lead = scheme === 'dark' ? palette.text : '#0B0D10';
  const bronze = palette.accent;

  return (
    <Svg
      width={height * (463 / 112)}
      height={height}
      viewBox="0 0 463 112"
      accessibilityRole="image"
      accessibilityLabel="DASH"
    >
      {/* D */}
      <Path
        fill={lead}
        fillRule="evenodd"
        d="M8 8h64c38 0 62 18 62 48s-24 48-62 48H8V8Zm25 23v50h37c24 0 38-8 38-25S94 31 70 31H33Z"
      />

      {/* Open A: two clean legs with no crossbar, matching the approved mark. */}
      <Path fill={lead} d="M132 104 176 8h25l-39 96h-30Z" />
      <Path fill={lead} d="M188 8h25l44 96h-31L188 8Z" />

      {/* S */}
      <Path
        fill={bronze}
        d="M253 23C267 11 288 5 315 5c27 0 48 6 64 18l-16 22c-13-9-29-14-47-14-18 0-27 4-27 11 0 6 10 9 32 12 40 5 59 19 59 43 0 27-25 43-67 43-30 0-55-8-72-23l18-22c15 12 34 18 56 18 20 0 30-4 30-12 0-7-10-10-33-13-38-6-57-20-57-43 0-9 3-16 8-22Z"
        transform="translate(0 -4) scale(.92)"
      />

      {/* H */}
      <Path fill={bronze} d="M353 8h27v37h56V8h27v96h-27V68h-56v36h-27V8Z" />
    </Svg>
  );
}
