/**
 * Turning FCM's answer into the port's contract.
 *
 * The adapter is thin — build a message, hand it to Firebase — but two
 * decisions inside it have real consequences, and neither can be observed from
 * outside without a stub.
 *
 * **Which failures mean a token is dead.** Report too many and working riders
 * are silently unsubscribed the first time a network blip fails a send; report
 * too few and uninstalled apps are notified for ever. Only codes that genuinely
 * mean "this token will never work again" may come back as `invalidTokens`.
 *
 * **How duplicates are suppressed.** The offer push travels through an
 * at-least-once outbox, so the same notification can legitimately be sent
 * twice; on a lock screen that reads as two jobs. The Android tag and collapse
 * key — and the APNs collapse id — must be keyed per offer. Shared across
 * offers, a second job would silently replace the first.
 */

import { describe, expect, it } from 'vitest';

import { FcmPushAdapter, type MulticastSender } from '../adapters/fcm.js';

interface Captured {
  tokens: string[];
  android?: { collapseKey?: string; ttl?: number; notification?: { tag?: string } };
  apns?: { headers?: Record<string, string> };
  data?: Record<string, string>;
  notification?: { title: string; body: string };
}

/** A Firebase stand-in that records what it was asked to send. */
function stub(outcomes: { success: boolean; code?: string }[]) {
  const sent: Captured[] = [];
  const sender: MulticastSender = {
    async sendEachForMulticast(message) {
      sent.push(message as Captured);
      return {
        successCount: outcomes.filter((outcome) => outcome.success).length,
        failureCount: outcomes.filter((outcome) => !outcome.success).length,
        responses: outcomes.map((outcome) => ({
          success: outcome.success,
          error: outcome.code ? { code: outcome.code } : undefined,
        })),
      };
    },
  };
  return { sender, sent };
}

const message = (data: Record<string, string>) => ({
  deviceTokens: ['tok-a', 'tok-b'],
  title: 'New delivery offer',
  body: 'Open DASH to accept it before it expires.',
  data,
});

describe('dead tokens are reported, transient failures are not', () => {
  it('reports a token Firebase says is no longer registered', async () => {
    const { sender } = stub([
      { success: true },
      { success: false, code: 'messaging/registration-token-not-registered' },
    ]);
    const adapter = new FcmPushAdapter(undefined, sender);

    const receipt = await adapter.send(message({ type: 'rider_offer', offerId: 'o1' }));

    expect(receipt.invalidTokens).toEqual(['tok-b']);
    // One handset took it, so the rider was reached.
    expect(receipt.accepted).toBe(true);
  });

  it('leaves a token alone when the send merely failed', async () => {
    // The failures that must NOT unsubscribe anyone: a network problem, a
    // quota error, an outage. Clearing tokens for these would quietly cut
    // riders off from work with nothing to show why.
    for (const code of [
      'messaging/server-unavailable',
      'messaging/internal-error',
      'messaging/quota-exceeded',
      'messaging/third-party-auth-error',
    ]) {
      const { sender } = stub([{ success: false, code }]);
      const adapter = new FcmPushAdapter(undefined, sender);

      const receipt = await adapter.send({
        ...message({ type: 'rider_offer' }),
        deviceTokens: ['tok-a'],
      });

      expect(receipt.invalidTokens, code).toEqual([]);
      expect(receipt.accepted, code).toBe(false);
    }
  });

  it('matches a failure to the right token by position', async () => {
    // `sendEachForMulticast` answers positionally. An off-by-one here would
    // clear a working rider's token and keep a dead one.
    const { sender } = stub([
      { success: false, code: 'messaging/registration-token-not-registered' },
      { success: true },
    ]);
    const adapter = new FcmPushAdapter(undefined, sender);

    const receipt = await adapter.send(message({ type: 'rider_offer' }));

    expect(receipt.invalidTokens).toEqual(['tok-a']);
  });
});

describe('a retried push replaces rather than repeats', () => {
  it('keys the collapse identity to the offer', async () => {
    const { sender, sent } = stub([{ success: true }, { success: true }]);
    const adapter = new FcmPushAdapter(undefined, sender);

    await adapter.send(message({ type: 'rider_offer', offerId: 'offer_42' }));

    // All three, because Android needs the tag to replace a notification that
    // is already showing and the collapse key to discard one still undelivered.
    expect(sent[0]?.android?.collapseKey).toBe('offer_42');
    expect(sent[0]?.android?.notification?.tag).toBe('offer_42');
    expect(sent[0]?.apns?.headers?.['apns-collapse-id']).toBe('offer_42');
  });

  it('does not collapse two different offers together', async () => {
    const { sender, sent } = stub([{ success: true }, { success: true }]);
    const adapter = new FcmPushAdapter(undefined, sender);

    await adapter.send(message({ type: 'rider_offer', offerId: 'offer_1' }));
    await adapter.send(message({ type: 'rider_offer', offerId: 'offer_2' }));

    expect(sent[0]?.android?.collapseKey).not.toBe(sent[1]?.android?.collapseKey);
  });

  it('expires the push with the offer it describes', async () => {
    // A push delivered after the offer has gone wakes a rider for nothing.
    const { sender, sent } = stub([{ success: true }, { success: true }]);
    const adapter = new FcmPushAdapter(undefined, sender);

    await adapter.send(message({ type: 'rider_offer', offerId: 'o1' }));

    expect(sent[0]?.android?.ttl).toBe(30_000);
  });
});

describe('the adapter adds nothing to the payload', () => {
  it('sends exactly the identifiers it was given', async () => {
    // Payload safety is asserted upstream in the domain. This guards the last
    // step: the adapter must not enrich the message on its way out.
    const { sender, sent } = stub([{ success: true }, { success: true }]);
    const adapter = new FcmPushAdapter(undefined, sender);

    await adapter.send(
      message({ type: 'rider_offer', offerId: 'o1', expiresAt: '2026-09-07T12:00:30.000Z' }),
    );

    expect(Object.keys(sent[0]?.data ?? {}).sort()).toEqual(['expiresAt', 'offerId', 'type']);
    expect(sent[0]?.notification?.title).toBe('New delivery offer');
  });

  it('does not call the provider when there is nobody to notify', async () => {
    const { sender, sent } = stub([]);
    const adapter = new FcmPushAdapter(undefined, sender);

    const receipt = await adapter.send({
      ...message({ type: 'rider_offer' }),
      deviceTokens: [],
    });

    expect(sent).toHaveLength(0);
    expect(receipt.accepted).toBe(true);
  });
});
