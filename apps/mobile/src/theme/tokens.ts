/**
 * DASH design tokens — the one place colour, type, space and shape are decided.
 *
 * Every value here was taken from the director-approved Customer and Rider
 * boards (docs/design/boards/2026-09-13), sampled from the pixels rather than
 * judged by eye, except where a board is silent — Dark mode above all, which
 * the boards do not show and which is therefore marked as a derivation awaiting
 * review.
 *
 * Screens never name a hex value. They ask for `palette.accent` or
 * `space.lg`, so the day a value changes it changes once, here, and every
 * screen follows — including the Dark variant, which must define exactly the
 * same keys as Light (a test holds that line).
 *
 * Pure data: no React Native import, so the tokens can be asserted by the
 * repository's test runner without a device or a renderer.
 */

export type ColorScheme = 'light' | 'dark';

export interface MapPalette {
  /** Route from the rider to the merchant. Blue on the Rider board — a map convention, not the brand. */
  routeToPickup: string;
  /** Route from the merchant to the customer. Deep green-black on both boards. */
  routeToCustomer: string;
  /** The rider's own vehicle marker. */
  riderMarker: string;
  pickupPin: string;
  dropoffPin: string;
  /** The customer's destination on the tracking map. */
  destinationPin: string;
}

/**
 * The DASH wordmark's two inks. Measured from the letter interiors on the
 * boards (see docs/design/boards/2026-09-13/wordmark), and deliberately not
 * `accent`: the mark's bronze is lighter and warmer than the button bronze.
 */
export interface WordmarkPalette {
  /** The D and the open A. */
  lead: string;
  /** The S, the H and the bar in the A. The same in both schemes. */
  bronze: string;
}

export interface Palette {
  /** Screen ground. Warm ivory. */
  background: string;
  /** Cards, tiles, sheets — anything that sits on the ground. */
  surface: string;
  /** Secondary buttons, segmented tracks, code boxes, quantity steppers. Warm sand. */
  sand: string;
  /** Recessed tiles lighter than sand: rider stat tiles, product photo grounds. */
  surfaceMuted: string;
  /** Hairlines and card borders. */
  line: string;

  text: string;
  textMuted: string;
  textSubtle: string;
  /** Text on the inverse chip (selected "All", selected storage option). */
  textOnInverse: string;
  /** Selected chip fill. Graphite on Light. */
  inverse: string;

  /** DASH bronze: primary buttons, active toggles, selected segments, links. */
  accent: string;
  accentPressed: string;
  /** Text and icons on an accent fill. See the contrast note on `light.onAccent`. */
  onAccent: string;
  /** Tinted accent ground: selected category bubble, soft highlights. */
  accentSoft: string;

  /** Star ratings. A warmer gold than the accent, on every board. */
  rating: string;
  success: string;
  successSoft: string;
  danger: string;
  dangerSoft: string;

  /** Active and inactive bottom-navigation tint. */
  tabActive: string;
  tabInactive: string;

  /** Dim layer behind a modal sheet. */
  scrim: string;

  map: MapPalette;
  wordmark: WordmarkPalette;
  /** Which system status-bar content style reads on `background`. */
  statusBar: 'dark' | 'light';
}

const light: Palette = {
  background: '#F8F7F2',
  surface: '#FFFFFF',
  sand: '#F1ECE1',
  surfaceMuted: '#F4F2EC',
  line: '#ECE7DD',

  text: '#0B0D10',
  textMuted: '#6E6B64',
  textSubtle: '#9A968D',
  textOnInverse: '#FFFFFF',
  inverse: '#15171A',

  /*
   * Sampled: #A07434 on the Rider board, #AC7C34 on the Customer board — the
   * two AI-rendered boards differ by a few shades. The midpoint is used for
   * both apps so there is one DASH bronze, not two.
   */
  accent: '#A67834',
  accentPressed: '#8C6429',
  /*
   * White on #A67834 is 3.9:1. That passes WCAG AA for large text (18.66px
   * bold and up) but not for the 15-16px semibold labels the boards use on
   * their primary buttons, where 4.5:1 is required. The approved design is
   * reproduced as drawn; the gap is reported for a director decision. A bronze
   * of #946A2B keeps the look and reaches 4.8:1 — a one-line change here.
   */
  onAccent: '#FFFFFF',
  accentSoft: '#F3E8D6',

  rating: '#CC902A',
  success: '#1F6B3B',
  successSoft: '#E5F0E8',
  danger: '#C8372F',
  dangerSoft: '#F9E7E5',

  tabActive: '#0B0D10',
  tabInactive: '#8E8A82',

  scrim: 'rgba(11, 13, 16, 0.45)',

  map: {
    routeToPickup: '#0A60EC',
    routeToCustomer: '#0F2B28',
    riderMarker: '#F2BE3A',
    pickupPin: '#A67834',
    dropoffPin: '#D93A32',
    destinationPin: '#F0780C',
  },
  wordmark: { lead: '#1D1D1D', bronze: '#B18546' },
  statusBar: 'dark',
};

/*
 * Dark — DERIVED, NOT FROM THE BOARDS.
 *
 * The approved boards are Light only. This is the same system inverted with
 * the same intentions: graphite grounds instead of ivory, warm off-white type,
 * and a bronze lifted enough to read on a dark surface — which then carries
 * dark text rather than white (graphite on #C4924A is 7.0:1). Offered for
 * review, not presented as approved.
 */
const dark: Palette = {
  background: '#0E0F11',
  surface: '#17181B',
  sand: '#24221F',
  surfaceMuted: '#1D1E21',
  line: '#2B2A27',

  text: '#F4F1EA',
  textMuted: '#A8A399',
  textSubtle: '#77736B',
  textOnInverse: '#0B0D10',
  inverse: '#F4F1EA',

  accent: '#C4924A',
  accentPressed: '#AE8040',
  onAccent: '#0B0D10',
  accentSoft: '#2E2517',

  rating: '#E0A63C',
  success: '#4CAF74',
  successSoft: '#16281D',
  danger: '#E5605A',
  dangerSoft: '#2E1715',

  tabActive: '#F4F1EA',
  tabInactive: '#7E7A72',

  scrim: 'rgba(0, 0, 0, 0.6)',

  map: {
    routeToPickup: '#4C8DFF',
    routeToCustomer: '#7FD1B9',
    riderMarker: '#F2BE3A',
    pickupPin: '#C4924A',
    dropoffPin: '#E5605A',
    destinationPin: '#F59A45',
  },
  /*
   * The boards show the mark on light grounds only. On a dark ground the
   * graphite letters take the scheme's warm off-white; the bronze is kept
   * exactly (5.8:1 on #0E0F11), so the mark changes colour, not shape.
   */
  wordmark: { lead: '#F4F1EA', bronze: '#B18546' },
  statusBar: 'light',
};

export const palettes: Readonly<Record<ColorScheme, Palette>> = { light, dark };

/**
 * Spacing, in density-independent points.
 *
 * Measured against the boards' 390pt phones: screens inset their content 16pt
 * from the edge, cards pad 12-16pt, and related items sit 8pt apart.
 */
export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  /** The horizontal inset every screen's content shares. */
  gutter: 16,
} as const;

/**
 * Corner radii. Mature and consistent rather than playful: tiles, cards and
 * primary buttons all sit at 12-14pt on the boards; only category bubbles and
 * filter chips go fully round.
 */
export const radius = {
  sm: 8,
  md: 12,
  lg: 14,
  xl: 20,
  pill: 999,
} as const;

/** Minimum touch target. Nothing tappable is smaller, whatever it looks like. */
export const touchTarget = 44;

/** Primary button height on the boards (≈52pt). */
export const controlHeight = { md: 44, lg: 52 } as const;

/**
 * Typeface: Manrope, DASH's established brand face. The boards are
 * AI-rendered and do not name a face; Manrope matches their geometric sans and
 * is what the web product already uses, so the two surfaces stay one family.
 *
 * Android does not synthesise weights for bundled fonts — `fontWeight` on a
 * custom family is ignored — so each weight is its own family name.
 */
export const fontFamily = {
  regular: 'Manrope_400Regular',
  medium: 'Manrope_500Medium',
  semibold: 'Manrope_600SemiBold',
  bold: 'Manrope_700Bold',
  extrabold: 'Manrope_800ExtraBold',
} as const;

export type FontWeightName = keyof typeof fontFamily;

/**
 * The Naira sign, in a face that has one.
 *
 * Manrope has no ₦ (U+20A6) in any weight — checked against the font files —
 * and every DASH price is in naira. React Native has no font fallback stack,
 * so a missing glyph drops to the platform face at a different weight from the
 * digits beside it: a visibly mismatched sign on every price. These are Inter's
 * ₦ alone, subset per weight (≈2KB each) and renamed "DASH Naira Sign" as the
 * SIL Open Font License asks of modified fonts; the licence ships beside them
 * in assets/fonts. `Text` swaps them in wherever a ₦ appears.
 */
export const nairaFamily: Record<FontWeightName, string> = {
  regular: 'DashNairaSign_400',
  medium: 'DashNairaSign_500',
  semibold: 'DashNairaSign_600',
  bold: 'DashNairaSign_700',
  extrabold: 'DashNairaSign_800',
};

export interface TypeStyle {
  fontSize: number;
  lineHeight: number;
  weight: FontWeightName;
  letterSpacing?: number;
}

/**
 * The type scale, read off the boards' hierarchy.
 *
 * `display` is the big money figure (₦25,400, ₦1,250,000) and the moments that
 * deserve it (Delivery Completed!). `title` is a screen or merchant name,
 * `heading` a section ("Featured Shops"), `body` the default.
 */
export const typeScale = {
  display: { fontSize: 30, lineHeight: 36, weight: 'extrabold', letterSpacing: -0.4 },
  title: { fontSize: 22, lineHeight: 28, weight: 'bold', letterSpacing: -0.2 },
  heading: { fontSize: 18, lineHeight: 24, weight: 'bold', letterSpacing: -0.1 },
  appBar: { fontSize: 18, lineHeight: 24, weight: 'bold' },
  bodyStrong: { fontSize: 15, lineHeight: 21, weight: 'semibold' },
  body: { fontSize: 15, lineHeight: 21, weight: 'medium' },
  label: { fontSize: 14, lineHeight: 19, weight: 'semibold' },
  caption: { fontSize: 13, lineHeight: 18, weight: 'medium' },
  micro: { fontSize: 11, lineHeight: 14, weight: 'semibold' },
} as const satisfies Record<string, TypeStyle>;

export type TypeVariant = keyof typeof typeScale;

/**
 * Elevation policy.
 *
 * The boards are nearly flat: cards separate from the ivory ground by a
 * hairline and the faintest shadow, never by a heavy drop. Only things that
 * genuinely float — the incoming-order sheet, a map card — get more.
 * iOS reads the shadow fields; Android reads `elevation`. The shadow colour is
 * part of each preset so no component names a colour to cast one.
 */
const SHADOW = '#000000';
export const elevation = {
  flat: { shadowColor: SHADOW, shadowOpacity: 0, shadowRadius: 0, shadowOffset: { width: 0, height: 0 }, elevation: 0 },
  card: { shadowColor: SHADOW, shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 1 },
  knob: { shadowColor: SHADOW, shadowOpacity: 0.15, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 2 },
  floating: { shadowColor: SHADOW, shadowOpacity: 0.12, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 6 },
} as const;

/** Motion durations. A small action gets a small response. */
export const motion = {
  press: 90,
  base: 200,
  emphasis: 360,
} as const;
