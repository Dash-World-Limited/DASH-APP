/**
 * Errors for the account-deletion and data-export flows.
 *
 * Translated to safe HTTP shapes in `http/errors.ts`. The `reason` is the
 * machine code; the `message` is safe to show a person.
 */

export class AccountDeletionError extends Error {
  constructor(
    readonly reason:
      | 'not_a_customer'
      | 'legal_hold'
      | 'already_completed'
      | 'not_found'
      | 'not_cancellable'
      | 'not_due',
    message: string,
    /** Extra context for the client, e.g. which legal hold applies. Non-secret. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AccountDeletionError';
  }
}

export class DataExportError extends Error {
  constructor(
    readonly reason:
      | 'not_found'
      | 'not_ready'
      | 'expired'
      | 'already_downloaded'
      | 'bad_token'
      | 'build_failed',
    message: string,
  ) {
    super(message);
    this.name = 'DataExportError';
  }
}
