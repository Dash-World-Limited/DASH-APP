/**
 * Adapters for capabilities this deployment does not have.
 *
 * Every method throws. That is the whole design, and it is the difference
 * between a Declutters deployment being *safe* and merely being *permitted*.
 *
 * The alternative — leaving the mock payment adapter or the console SMS adapter
 * wired on a deployment whose guards no longer check them — is the exact
 * failure the strict guards existed to prevent: a production service that
 * reports a successful charge and settles nothing, or logs a login code to
 * stdout and tells the customer it was sent. Relaxing a guard without replacing
 * the adapter would have traded one silent failure for another.
 *
 * `isLive` is `false` and `providerName` says `disabled`, so anything that
 * inspects a port to decide whether to trust it gets a truthful answer before
 * it ever calls a method.
 */

import type {
  DeliveryReceipt,
  ExportArchivePort,
  GeoPort,
  GeocodeResult,
  PaymentIntent,
  PaymentPort,
  PaymentStatus,
  PaymentWebhookEvent,
  PushPort,
  PushReceipt,
  CardSetupResult,
  PayoutBank,
  RefundLookup,
  RouteEstimate,
  SmsPort,
} from '@dash/domain/ports';
// `LatLng` is a geo type the ports module re-uses rather than owns.
import type { LatLng } from '@dash/domain/geo';
import { CapabilityDisabledError } from '../deployment/profile.js';

export class DisabledPaymentAdapter implements PaymentPort {
  readonly providerName = 'disabled';
  readonly isLive = false;

  async initialize(): Promise<PaymentIntent> {
    throw new CapabilityDisabledError('payments');
  }

  async verify(): Promise<PaymentIntent> {
    throw new CapabilityDisabledError('payments');
  }

  async refund(): Promise<{ refundReference: string; status: PaymentStatus }> {
    throw new CapabilityDisabledError('payments');
  }

  async lookupRefund(): Promise<RefundLookup> {
    throw new CapabilityDisabledError('payments');
  }

  async listBanks(): Promise<readonly PayoutBank[]> {
    throw new CapabilityDisabledError('payments');
  }

  async resolveBankAccount(): Promise<{ accountName: string } | null> {
    throw new CapabilityDisabledError('payments');
  }

  async initializeCardSetup(): Promise<{ authorizationUrl: string }> {
    throw new CapabilityDisabledError('payments');
  }

  async verifyCardSetup(): Promise<CardSetupResult> {
    throw new CapabilityDisabledError('payments');
  }

  async deactivateCard(): Promise<void> {
    throw new CapabilityDisabledError('payments');
  }

  /**
   * Returns null rather than throwing, matching the contract.
   *
   * `parseWebhook` returning null already means "this did not verify, treat it
   * as hostile and act on nothing". A deployment with payments off should treat
   * every payment webhook exactly that way, and the caller already handles it
   * correctly.
   */
  parseWebhook(): PaymentWebhookEvent | null {
    return null;
  }
}

export class DisabledSmsAdapter implements SmsPort {
  readonly providerName = 'disabled';
  readonly isLive = false;

  async send(): Promise<DeliveryReceipt> {
    throw new CapabilityDisabledError('sms');
  }
}

export class DisabledPushAdapter implements PushPort {
  readonly providerName = 'disabled';
  readonly isLive = false;

  async send(): Promise<PushReceipt> {
    throw new CapabilityDisabledError('push');
  }
}

/**
 * Geo with maps off.
 *
 * `zonesContaining` is deliberately *not* disabled: it is answered by PostGIS,
 * which the Declutters profile still requires, and it is a database query
 * rather than a call to a maps provider. Routing and geocoding are the parts
 * that need a provider, and those throw.
 *
 * The distinction matters because the delivery-zone question is the one thing
 * DASH answers without a third party, and pretending otherwise would mean
 * requiring a maps key for a query that never leaves the database.
 */
export class DisabledMapsGeoAdapter implements GeoPort {
  readonly providerName = 'disabled';
  readonly isLive = false;

  constructor(private readonly zones: Pick<GeoPort, 'zonesContaining'>) {}

  async route(_from: LatLng, _to: LatLng): Promise<RouteEstimate> {
    throw new CapabilityDisabledError('maps');
  }

  async geocode(): Promise<readonly GeocodeResult[]> {
    throw new CapabilityDisabledError('maps');
  }

  async reverseGeocode(): Promise<GeocodeResult | null> {
    throw new CapabilityDisabledError('maps');
  }

  async zonesContaining(point: LatLng, cityId: string): Promise<readonly string[]> {
    return await this.zones.zonesContaining(point, cityId);
  }
}

export class DisabledExportArchiveAdapter implements ExportArchivePort {
  readonly providerName = 'disabled';
  readonly isLive = false;

  async write(): Promise<{ sizeBytes: number }> {
    throw new CapabilityDisabledError('dataExport');
  }

  async read(): Promise<Buffer> {
    throw new CapabilityDisabledError('dataExport');
  }

  async delete(): Promise<void> {
    throw new CapabilityDisabledError('dataExport');
  }
}
