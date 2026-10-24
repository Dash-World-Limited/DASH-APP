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

import { FcmPushAdapter, isDeadTokenError, type MulticastSender } from '../adapters/fcm.js';

interface Captured {
  tokens: string[];
  android?: { collapseKey?: string; ttl?: number; notification?: { tag?: string } };
  apns?: { headers?: Record<string, string> };
  data?: Record<string, string>;
  notification?: { title: string; body: string };
}

/** A Firebase stand-in that records what it was asked to send. */
function stub(outcomes: { success: boolean; code?: string; message?: string }[]) {
  const sent: Captured[] = [];
  const sender: MulticastSender = {
    async sendEachForMulticast(message) {
      sent.push(message as Captured);
      return {
        successCount: outcomes.filter((outcome) => outcome.success).length,
        failureCount: outcomes.filter((outcome) => !outcome.success).length,
        responses: outcomes.map((outcome) => ({
          success: outcome.success,
          error: outcome.code ? { code: outcome.code, message: outcome.message } : undefined,
        })),
      };
    },
  };
  return { sender, sent };
}

const message_ = (data: Record<string, string>) => ({
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

    const receipt = await adapter.send(message_({ type: 'rider_offer', offerId: 'o1' }));

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
        ...message_({ type: 'rider_offer' }),
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

    const receipt = await adapter.send(message_({ type: 'rider_offer' }));

    expect(receipt.invalidTokens).toEqual(['tok-a']);
  });
});

describe('a retried push replaces rather than repeats', () => {
  it('keys the collapse identity to the offer', async () => {
    const { sender, sent } = stub([{ success: true }, { success: true }]);
    const adapter = new FcmPushAdapter(undefined, sender);

    await adapter.send(message_({ type: 'rider_offer', offerId: 'offer_42' }));

    // All three, because Android needs the tag to replace a notification that
    // is already showing and the collapse key to discard one still undelivered.
    expect(sent[0]?.android?.collapseKey).toBe('offer_42');
    expect(sent[0]?.android?.notification?.tag).toBe('offer_42');
    expect(sent[0]?.apns?.headers?.['apns-collapse-id']).toBe('offer_42');
  });

  it('does not collapse two different offers together', async () => {
    const { sender, sent } = stub([{ success: true }, { success: true }]);
    const adapter = new FcmPushAdapter(undefined, sender);

    await adapter.send(message_({ type: 'rider_offer', offerId: 'offer_1' }));
    await adapter.send(message_({ type: 'rider_offer', offerId: 'offer_2' }));

    expect(sent[0]?.android?.collapseKey).not.toBe(sent[1]?.android?.collapseKey);
  });

  it('expires the push with the offer it describes', async () => {
    // A push delivered after the offer has gone wakes a rider for nothing.
    const { sender, sent } = stub([{ success: true }, { success: true }]);
    const adapter = new FcmPushAdapter(undefined, sender);

    await adapter.send(message_({ type: 'rider_offer', offerId: 'o1' }));

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
      message_({ type: 'rider_offer', offerId: 'o1', expiresAt: '2026-09-07T12:00:30.000Z' }),
    );

    expect(Object.keys(sent[0]?.data ?? {}).sort()).toEqual(['expiresAt', 'offerId', 'type']);
    expect(sent[0]?.notification?.title).toBe('New delivery offer');
  });

  it('does not call the provider when there is nobody to notify', async () => {
    const { sender, sent } = stub([]);
    const adapter = new FcmPushAdapter(undefined, sender);

    const receipt = await adapter.send({
      ...message_({ type: 'rider_offer' }),
      deviceTokens: [],
    });

    expect(sent).toHaveLength(0);
    expect(receipt.accepted).toBe(true);
  });
});

describe('an ambiguous invalid-argument does not condemn a token', () => {
  /**
   * `messaging/invalid-argument` covers anything malformed in the request — a
   * bad TTL, an oversized payload, an unacceptable notification option — as
   * well as a bad registration token. The code alone does not say which.
   *
   * Deleting on the code alone would mean a mistake in *our* message
   * construction unregistering every rider it reached. A bad TTL constant would
   * be rejected for all tokens at once, and the response would be to delete all
   * of them: a one-line bug becoming a silent, total outage of rider
   * notifications, with the evidence removed as it happened.
   */
  it('keeps the token when the payload is what Firebase rejected', async () => {
    for (const message of [
      'Invalid JSON payload received.',
      'ttl must be a non-negative duration',
      'The value for android.notification.color is invalid',
      'Request contains an invalid argument.',
      undefined,
    ]) {
      const { sender } = stub([{ success: false, code: 'messaging/invalid-argument', message }]);
      const adapter = new FcmPushAdapter(undefined, sender);

      const receipt = await adapter.send({
        ...message_({ type: 'rider_offer', offerId: 'o1' }),
        deviceTokens: ['tok-a'],
      });

      expect(receipt.invalidTokens, String(message)).toEqual([]);
    }
  });

  it('condemns the token only when Firebase names it', async () => {
    const { sender } = stub([
      {
        success: false,
        code: 'messaging/invalid-argument',
        message: 'The registration token is not a valid FCM registration token',
      },
    ]);
    const adapter = new FcmPushAdapter(undefined, sender);

    const receipt = await adapter.send({
      ...message_({ type: 'rider_offer', offerId: 'o1' }),
      deviceTokens: ['tok-a'],
    });

    expect(receipt.invalidTokens).toEqual(['tok-a']);
  });

  it('fails towards keeping a rider when the wording is unfamiliar', () => {
    // If Firebase rewords its message, the check stops matching and the token
    // survives. A rider who keeps getting work is the safe side of that error.
    expect(
      isDeadTokenError('messaging/invalid-argument', 'some future wording', true),
    ).toBe(false);
  });

  it('will not blame the token when the payload was never validated', () => {
    // The precondition. An unvalidated payload makes our own message the
    // likelier suspect, so the token is not condemned even on matching wording.
    expect(
      isDeadTokenError(
        'messaging/invalid-argument',
        'The registration token is not a valid FCM registration token',
        false,
      ),
    ).toBe(false);
  });

  it('still condemns the two codes that name the token themselves', () => {
    expect(isDeadTokenError('messaging/registration-token-not-registered', undefined, true)).toBe(true);
    expect(isDeadTokenError('messaging/invalid-registration-token', undefined, true)).toBe(true);
  });

  it('ignores a missing code', () => {
    expect(isDeadTokenError(undefined, 'anything', true)).toBe(false);
  });
});
