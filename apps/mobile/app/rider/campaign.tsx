/**
 * Where the Rider Home campaign card leads.
 *
 * The card is a campaign ("Deliver More Possibilities"), so it opens the
 * campaign, not Earnings, which is what it used to open. DASH has no rider
 * campaign system yet, so this is the designed "not built yet" destination and
 * says so; nothing here promises a bonus that does not exist.
 */

import heroScooter from '../../assets/staging/rider/home-hero-scooter.png';
import { ComingScreen } from '../../src/ui/ComingScreen';

export default function RiderCampaign() {
  return (
    <ComingScreen
      title="Deliver More Possibilities"
      icon="bullhorn-outline"
      art={heroScooter}
      headline="Rider campaigns"
      body="Incentives, busy-time bonuses and zone announcements from DASH operations will be explained here: what each one pays, where and when, and how it is counted."
      waitingOn="Arrives with rider incentives. Campaigns will be published by DASH operations and paid by the server; none is running in this build."
    />
  );
}
