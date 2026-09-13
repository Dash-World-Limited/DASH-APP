/**
 * The DASH wordmark — the approved all-caps mark from the director's boards.
 *
 * INTERIM ASSET. There is no master file yet, so this is the mark cropped from
 * the Customer board's footer (its largest instance), keyed to transparency and
 * upscaled. It is the approved mark, not a redrawing — DASH World's rule is
 * that logo geometry is never redrawn, stretched or reinterpreted — but it is
 * soft at device resolution. Replacing it is one file swap in
 * assets/brand/, and the aspect ratio below.
 *
 * The retired mark with a dot after DASH is not used anywhere in this app.
 *
 * Dark mode uses a variant in which only the graphite letters are lightened;
 * the bronze and the notch in the A are untouched. The boards do not show a
 * dark variant, so that one is a derivation pending approval.
 */

import { Image } from 'expo-image';

import darkMark from '../../assets/brand/dash-wordmark-on-dark.png';
import lightMark from '../../assets/brand/dash-wordmark.png';
import { useTheme } from '../theme/ThemeProvider';

/** Width over height of the extracted mark (576 × 156). */
const ASPECT = 576 / 156;

export function Wordmark({ height = 22 }: { height?: number }) {
  const { scheme } = useTheme();
  return (
    <Image
      source={scheme === 'dark' ? darkMark : lightMark}
      style={{ height, width: height * ASPECT }}
      contentFit="contain"
      accessibilityRole="header"
      accessibilityLabel="DASH"
    />
  );
}
