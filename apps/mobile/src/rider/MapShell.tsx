/**
 * The map on platforms without a native map — the web design preview.
 *
 * Metro picks `MapShell.native.tsx` on iOS and Android, and this file on web,
 * so the native maps module is never bundled where it cannot run. The preview
 * shows the route's shape and says plainly that the real map is a device
 * feature.
 */

import { MapFallback, type MapShellProps } from './MapFallback';

export type { MapShellProps } from './MapFallback';

export function MapShell(props: MapShellProps) {
  return <MapFallback {...props} reason="Preview — the native map renders on the device" />;
}
