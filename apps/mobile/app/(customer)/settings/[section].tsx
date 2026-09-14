/** Settings sections, inside the Customer face's stack so Back returns to Profile & Settings. */

import { SettingsSection } from '../../../src/screens/SettingsSection';

export default function CustomerSettingsSection() {
  return <SettingsSection fallback="/account" />;
}
