/**
 * The only way text reaches the screen.
 *
 * A variant names a role from the type scale and a tone names a meaning from
 * the palette; neither is a raw number or colour. That is what keeps two
 * section headings on two screens identical, and what lets Dark mode work
 * without every screen being edited.
 *
 * Text scales with the system font size — people who need larger type get it —
 * but only to 1.5x, the point past which a two-column product grid stops being
 * a layout. Past that, the platform's own magnification is the right tool.
 */

import { Children, type ReactNode } from 'react';
import { Text as NativeText, type TextProps as NativeTextProps, type TextStyle } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { fontFamily, nairaFamily, typeScale, type FontWeightName, type TypeVariant } from '../theme/tokens';
import type { Palette } from '../theme/tokens';

export type TextTone =
  | 'default'
  | 'muted'
  | 'subtle'
  | 'accent'
  | 'success'
  | 'danger'
  | 'onAccent'
  | 'onInverse'
  | 'rating';

const TONE: Record<TextTone, (palette: Palette) => string> = {
  default: (p) => p.text,
  muted: (p) => p.textMuted,
  subtle: (p) => p.textSubtle,
  accent: (p) => p.accent,
  success: (p) => p.success,
  danger: (p) => p.danger,
  onAccent: (p) => p.onAccent,
  onInverse: (p) => p.textOnInverse,
  rating: (p) => p.rating,
};

export interface TextProps extends NativeTextProps {
  variant?: TypeVariant;
  tone?: TextTone;
  align?: TextStyle['textAlign'];
  /** Override the variant's weight without inventing a new variant. */
  weight?: keyof typeof fontFamily;
}

/**
 * Render every ₦ in the Naira-sign face at the surrounding weight.
 *
 * Only string children are touched, and only when they contain the sign, so
 * the common case costs a single `includes`. The sign becomes a nested Text,
 * which inherits size, colour and line height and changes only the family.
 */
function withNairaSign(children: ReactNode, weight: FontWeightName): ReactNode {
  const swap = (text: string, key: number): ReactNode[] =>
    text.split('₦').flatMap((part, index) =>
      index === 0
        ? [part]
        : [
            <NativeText key={`${key}-${index}`} style={{ fontFamily: nairaFamily[weight] }}>
              ₦
            </NativeText>,
            part,
          ],
    );
  if (typeof children === 'string') return children.includes('₦') ? swap(children, 0) : children;
  if (!Array.isArray(children)) return children;
  return Children.toArray(children).flatMap((child, key) =>
    typeof child === 'string' && child.includes('₦') ? swap(child, key) : [child],
  );
}

export function Text({ variant = 'body', tone = 'default', align, weight, style, children, ...rest }: TextProps) {
  const { palette } = useTheme();
  const type = typeScale[variant];
  const resolvedWeight = weight ?? type.weight;
  return (
    <NativeText
      maxFontSizeMultiplier={1.5}
      style={[
        {
          fontFamily: fontFamily[resolvedWeight],
          fontSize: type.fontSize,
          lineHeight: type.lineHeight,
          letterSpacing: 'letterSpacing' in type ? type.letterSpacing : 0,
          color: TONE[tone](palette),
          textAlign: align,
        },
        style,
      ]}
      {...rest}
    >
      {withNairaSign(children, resolvedWeight)}
    </NativeText>
  );
}
