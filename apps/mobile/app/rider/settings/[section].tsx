/** Settings sections, inside the Rider face's stack so Back returns to the rider's own screen. */

import { SettingsSection } from '../../../src/screens/SettingsSection';

export default function RiderSettingsSection() {
  return <SettingsSection fallback="/rider/profile" />;
}
