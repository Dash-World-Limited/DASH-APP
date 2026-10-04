/**
 * Icons, from one set.
 *
 * The boards draw line icons with a filled counterpart for the active tab —
 * an outlined house becomes a solid one. Material Community Icons carries both
 * forms for every glyph DASH needs and ships inside Expo, so there is no second
 * icon library and no hand-drawn SVG to maintain.
 *
 * Icons are decorative by default and hidden from screen readers; the control
 * they sit in carries the accessible label. An icon that *is* the content
 * passes `label`.
 */

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { ComponentProps } from 'react';

export type IconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

export function Icon({
  name,
  size = 22,
  color,
  label,
}: {
  name: IconName;
  size?: number;
  color: string;
  label?: string;
}) {
  return (
    <MaterialCommunityIcons
      name={name}
      size={size}
      color={color}
      accessible={Boolean(label)}
      accessibilityLabel={label}
      importantForAccessibility={label ? 'yes' : 'no-hide-descendants'}
    />
  );
}
