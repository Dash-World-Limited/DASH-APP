/**
 * A service whose flow is not in this checkpoint.
 *
 * Shops is built as the first merchant service, because it is the flow the
 * approved Customer board draws end to end. Food, Pharmacy and Local Market
 * reuse the same standard storefront frame and switch on service by service.
 * Declutter and Logistics are different businesses with their own domains,
 * and each says what it is waiting on rather than borrowing a merchant screen
 * that would misdescribe it.
 */

import { isServiceCategoryId, type ServiceCategoryId } from '@dash/domain/services';
import { Redirect, useLocalSearchParams } from 'expo-router';

import { SERVICE_PRESENTATION } from '../../../../../src/data/services';
import { ComingScreen } from '../../../../../src/ui/ComingScreen';

const COPY: Record<Exclude<ServiceCategoryId, 'shops'>, { headline: string; body: string; waitingOn: string }> = {
  food: {
    headline: 'Restaurants are next',
    body: 'Browse kitchens near you, open a menu of photographed dishes, and follow your order from the kitchen to your door.',
    waitingOn:
      'Uses the same DASH storefront as Shops. It opens once restaurant menus are served with their photographs — the first full vertical slice after staging.',
  },
  pharmacy: {
    headline: 'Pharmacy is on its way',
    body: 'Approved pharmacies for everyday health needs, with the same clear storefront and tracked delivery.',
    waitingOn: 'Uses the same DASH storefront as Shops, and opens once pharmacy catalogues are served with photographs.',
  },
  local_market: {
    headline: 'Local Market is on its way',
    body: 'Fresh produce and staples from market traders, priced by the trader and delivered by DASH.',
    waitingOn: 'Uses the same DASH storefront as Shops, and opens once market catalogues are served with photographs.',
  },
  declutter: {
    headline: 'DASH Declutter',
    body: 'Pre-owned items at fixed, DASH ValueChecked prices — collect them yourself or have DASH deliver.',
    waitingOn:
      'Declutter is its own marketplace, built by the DASH World Declutters workstream. It connects here once the shared listing contract is approved — not as a copy inside this app.',
  },
  logistics: {
    headline: 'Send anything across the city',
    body: 'Book a rider or a van to move a package from one address to another, and follow it the whole way.',
    waitingOn:
      'Logistics needs its own shipment domain — sender, recipient, package, quote and proof of delivery — before booking can open. It is not a restaurant order.',
  },
};

export default function ServiceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!isServiceCategoryId(id)) return <Redirect href="/" />;
  if (id === 'shops') return <Redirect href="/shops" />;

  const presentation = SERVICE_PRESENTATION[id];
  const copy = COPY[id];
  return (
    <ComingScreen
      title={presentation.label}
      headline={copy.headline}
      body={copy.body}
      waitingOn={copy.waitingOn}
      art={presentation.art}
    />
  );
}
