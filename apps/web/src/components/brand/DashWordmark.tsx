/**
 * The DASH wordmark on the web: the same measured outlines the native app
 * draws (see docs/design/boards/2026-09-13/wordmark).
 *
 * Locked brand requirement: the brand is this artwork, exactly DASH, with no
 * dot after it. It is never typed, never set in a font, never approximated
 * with weight or letter-spacing.
 *
 * The D and the open A take `currentColor`, so the surrounding text colour
 * decides graphite on light surfaces and off-white on dark panels. The S, the H
 * and the bar in the A are the wordmark bronze. Height is in `em` by default,
 * so the mark follows the font-size of the place it sits.
 */

import {
  WORDMARK_ASPECT,
  WORDMARK_BRONZE_PATH,
  WORDMARK_GRAPHITE_PATH,
  WORDMARK_VIEWBOX,
} from './wordmarkGeometry';

/** The measured bronze (#B18546): lighter and warmer than the button accent. */
const BRONZE = 'var(--dash-wordmark-bronze, #B18546)';

export function DashWordmark({
  height = '0.72em',
  className,
}: {
  /** Letter height, as a CSS length. 0.72em matches the cap height of the text it replaced. */
  height?: string;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox={WORDMARK_VIEWBOX}
      role="img"
      aria-label="DASH"
      style={{ height, width: `calc(${height} * ${WORDMARK_ASPECT})`, display: 'inline-block', flexShrink: 0 }}
    >
      <path fill="currentColor" fillRule="evenodd" d={WORDMARK_GRAPHITE_PATH} />
      <path fill={BRONZE} d={WORDMARK_BRONZE_PATH} />
    </svg>
  );
}
