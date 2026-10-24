/**
 * Firebase Cloud Messaging, behind `PushPort`.
 *
 * The only thing in the codebase that knows Firebase exists. Everything else —
 * the dispatch worker that publishes an offer push, the send path that checks
 * eligibility, the registration that binds a token to an identity — is written
 * against the port, so swapping providers or running without one changes this
 * file and nothing else.
 *
 * ## Credentials
 *
 * Application Default Credentials, which reads `GOOGLE_APPLICATION_CREDENTIALS`
 * from the environment. Neither the path nor the file's contents appear here or
 * anywhere else in the repository: the SDK resolves it at initialisation, and
 * on a cloud host the same code picks up the platform's own service identity
 * with no file at all. That is the whole reason to use ADC rather than reading
 * a key ourselves — the credential never becomes something this project has to
 * hold, log, or accidentally commit.
 *
 * ## Duplicate notifications
 *
 * The offer push is published through the transactional outbox, which is
 * at-least-once by design: a relay that crashes after sending and before
 * marking the row published will send again. That is correct for a durable
 * queue and wrong for a rider's lock screen, where it means the same job
 * buzzing twice.
 *
 * Both platforms have a native answer and both are used. Android's `tag`
 * replaces any showing notification with the same tag rather than stacking a
 * second one, and `collapseKey` lets FCM discard an undelivered duplicate
 * while the handset is offline. Keyed per offer, so two pushes about one offer
 * collapse into one and pushes about different offers never do.
 */

import { getApps, initializeApp, applicationDefault, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { PushPort, PushReceipt } from '@dash/domain/ports';

/**
 * Errors that unambiguously mean the token is dead.
 *
 * A dead token is not retryable — the app was uninstalled, the OS reissued the
 * token, the device was wiped — so these are reported as `invalidTokens` and
 * the caller clears them. Everything else leaves the token alone: treating a
 * network blip as a dead handset would silently unsubscribe working riders.
 *
 * Both of these name the registration token in the code itself, which is what
 * makes them safe to act on without reading any further.
 */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/**
 * `messaging/invalid-argument` is deliberately absent from that set.
 *
 * Firebase uses it for anything malformed in the request — a bad TTL, an
 * oversized payload, an unacceptable notification option — as well as for a
 * bad registration token. The code alone does not say which.
 *
 * Deleting on the code alone would mean a mistake in *our* message construction
 * unregistering every rider it was sent to. A bad TTL constant, say, would be
 * rejected for all tokens at once, and the system's response would be to
 * quietly delete all of them — turning a one-line bug into a silent, total
 * outage of rider notifications that looks like riders simply going quiet, with
 * the evidence deleted as it happens. The failure is self-inflicted, total, and
 * invisible, which is the worst combination.
 *
 * So a token is only condemned under this code when Firebase's own message
 * names the registration token as the problem. If the wording ever changes, the
 * check stops matching and the token survives — failing towards a rider who
 * keeps getting work rather than one who is silently cut off.
 */
const TOKEN_BLAMED = /registration token|not a valid fcm registration/i;

/**
 * Whether this failure proves the token itself is dead.
 *
 * `payloadValidated` records that the outgoing message already passed the
 * domain's payload rules before it was sent. It does not make an ambiguous
 * error unambiguous — that is what `TOKEN_BLAMED` is for — but it is the
 * precondition under which blaming the token is reasonable at all: an
 * unvalidated payload would make our own message the likelier suspect.
 */
export function isDeadTokenError(
  code: string | undefined,
  message: string | undefined,
  payloadValidated: boolean,
): boolean {
  if (!code) return false;
  if (DEAD_TOKEN_CODES.has(code)) return true;

  if (code === 'messaging/invalid-argument') {
    return payloadValidated && Boolean(message && TOKEN_BLAMED.test(message));
  }

  return false;
}

/**
 * The slice of the Firebase SDK this adapter uses.
 *
 * Narrowed to one method so the mapping below — which token outcomes mean
 * "dead" and which mean "try again" — can be tested against a stub. That
 * mapping is the part with real consequences: getting it wrong either
 * unsubscribes working riders on a network blip, or keeps paying to notify
 * handsets that no longer exist.
 */
export interface MulticastSender {
  sendEachForMulticast(message: {
    tokens: string[];
    notification?: { title: string; body: string } | undefined;
    data?: Record<string, string> | undefined;
    android?: unknown;
    apns?: unknown;
  }): Promise<{
    successCount: number;
    failureCount: number;
    responses: { success: boolean; error?: { code?: string; message?: string } | undefined }[];
  }>;
}

export class FcmPushAdapter implements PushPort {
  readonly providerName = 'fcm';
  readonly isLive = true;

  private readonly messaging: MulticastSender;

  constructor(app?: App, sender?: MulticastSender) {
    if (sender) {
      this.messaging = sender;
      return;
    }
    // One Firebase app per process. `getApps()` matters in tests and in dev,
    // where a server may be built more than once in the same process and a
    // second `initializeApp` would throw.
    const existing = getApps();
    const firebase =
      app ??
      existing[0] ??
      initializeApp({
        // Resolves GOOGLE_APPLICATION_CREDENTIALS, or the host's own service
        // identity when running on Google infrastructure. Never a path or a
        // key literal in this repository.
        credential: applicationDefault(),
      });

    this.messaging = getMessaging(firebase) as unknown as MulticastSender;
  }

  async send(input: {
    deviceTokens: readonly string[];
    title: string;
    body: string;
    data?: Readonly<Record<string, string>> | undefined;
  }): Promise<PushReceipt> {
    if (input.deviceTokens.length === 0) {
      return { accepted: true, providerMessageId: undefined };
    }

    // The collapse identity of this notification. An offer id when there is
    // one — which is every push DASH currently sends — so retries of the same
    // offer replace each other rather than stacking, and different offers stay
    // separate.
    const collapseId = input.data?.['offerId'] ?? input.data?.['type'] ?? 'dash';

    const response = await this.messaging.sendEachForMulticast({
      tokens: [...input.deviceTokens],
      notification: { title: input.title, body: input.body },
      // Identifiers only — see packages/domain/src/push. This adapter does not
      // add to the payload, so what was asserted safe upstream is what is sent.
      data: input.data ? { ...input.data } : undefined,
      android: {
        priority: 'high',
        // Thirty seconds is the offer's whole life. A push that could not be
        // delivered inside it is describing work that has already gone, and
        // waking a rider for it is worse than not waking them at all.
        ttl: 30_000,
        collapseKey: collapseId,
        notification: {
          tag: collapseId,
          // Replaces rather than re-alerts, so a retry does not buzz twice.
          notificationCount: 1,
        },
      },
      apns: {
        headers: {
          'apns-collapse-id': collapseId,
          'apns-priority': '10',
        },
      },
    });

    // Map per-token outcomes back to the port's contract. `sendEachForMulticast`
    // returns results positionally, so a response index is its token's index.
    const invalidTokens: string[] = [];
    response.responses.forEach((result, index) => {
      if (result.success) return;
      const error = result.error as { code?: string; message?: string } | undefined;
      const token = input.deviceTokens[index];
      // `payloadValidated` is true because `sendToRider` runs the domain's
      // payload rules immediately before calling this adapter, and this adapter
      // adds nothing to what it was given.
      if (token && isDeadTokenError(error?.code, error?.message, true)) {
        invalidTokens.push(token);
      }
    });

    return {
      // Accepted when at least one handset took it. A rider with three devices
      // and one dead token has still been reached.
      accepted: response.successCount > 0,
      providerMessageId: undefined,
      failureReason:
        response.successCount === 0 ? `all ${response.failureCount} sends failed` : undefined,
      invalidTokens,
    };
  }
}

/**
 * Build the adapter.
 *
 * Called at boot when `PUSH_PROVIDER=fcm`.
 *
 * **Application Default Credentials resolve lazily**, which is worth stating
 * plainly because it is not what you would assume: `initializeApp` with
 * `applicationDefault()` succeeds even when no credential exists anywhere, and
 * the failure surfaces on the first actual send. Verified, not assumed — the
 * server boots reporting `push provider: fcm` with the variable unset.
 *
 * So this cannot fail fast on a missing credential, and does not pretend to.
 * Two things cover the gap instead: `config.ts` refuses to start production
 * with `PUSH_PROVIDER=fcm` and no `GOOGLE_APPLICATION_CREDENTIALS`, and a send
 * that fails returns a receipt rather than throwing, so a misconfiguration
 * costs a notification rather than an order.
 *
 * The wrapper below still catches genuine construction failures — a malformed
 * app config, an unreadable credential file — and names the variable
 * responsible, because Firebase's own error does not.
 */
export function createFcmAdapter(): FcmPushAdapter {
  try {
    return new FcmPushAdapter();
  } catch (error) {
    throw new Error(
      'PUSH_PROVIDER=fcm but Firebase credentials could not be resolved. ' +
        'Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON, or run on a ' +
        `host with its own service identity. Underlying error: ${String(
          (error as Error)?.message ?? error,
        )}`,
    );
  }
}
