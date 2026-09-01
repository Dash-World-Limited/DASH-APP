/**
 * Error handling.
 *
 * One shape for every error the API returns:
 *
 *   { error: { code, message, requestId, details? } }
 *
 * `message` is always safe to show a user. Anything diagnostic — a stack, a
 * database constraint name, which record failed a scope check — goes to the log
 * against `requestId` and never crosses the wire. That split is what stops
 * error messages becoming an enumeration oracle.
 */

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AuthorizationError } from '@dash/domain/permissions';
import { OrderTransitionError } from '@dash/domain/orders';
import { PricingError } from '@dash/domain/pricing';
import { MoneyError } from '@dash/domain/money';
import { GeoError } from '@dash/domain/geo';
import { LedgerError } from '@dash/domain/ledger';
import { TokenError } from '../auth/tokens.js';
import { SessionError } from '../auth/sessions.js';
import { MfaError } from '../auth/mfa.js';
import { EnvelopeError } from '@dash/domain/envelope';
import { PayoutDetailsError } from '../vendor/payout.js';

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /** Logged, never serialized. */
    readonly internal?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, 'bad_request', message, details);
  }

  static unauthorized(message = 'Sign in to continue.'): ApiError {
    return new ApiError(401, 'unauthorized', message);
  }

  static forbidden(message = 'You do not have access to perform this action.'): ApiError {
    return new ApiError(403, 'forbidden', message);
  }

  /**
   * Used both for genuinely missing records and for records the caller may not
   * see. The two must be indistinguishable from outside.
   */
  static notFound(message = 'Not found.', internal?: string): ApiError {
    return new ApiError(404, 'not_found', message, undefined, internal);
  }

  static conflict(message: string, details?: unknown): ApiError {
    return new ApiError(409, 'conflict', message, details);
  }

  static unprocessable(message: string, details?: unknown): ApiError {
    return new ApiError(422, 'unprocessable', message, details);
  }

  static tooManyRequests(message = 'Too many attempts. Try again shortly.'): ApiError {
    return new ApiError(429, 'rate_limited', message);
  }

  static internal(internal: string): ApiError {
    return new ApiError(
      500,
      'internal_error',
      'Something went wrong on our side. Please try again.',
      undefined,
      internal,
    );
  }
}

interface ErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

/**
 * Map a thrown value to a status, a public code, and a public message.
 *
 * Domain errors are translated here rather than at each call site, so a new
 * route cannot accidentally leak an internal message by forgetting to catch.
 */
function translate(error: unknown): {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  internal?: string;
} {
  if (error instanceof ApiError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
      internal: error.internal,
    };
  }

  if (error instanceof ZodError) {
    // Field paths and messages are safe and genuinely useful to a client.
    // Received values are NOT included — a rejected password must not echo back.
    return {
      statusCode: 400,
      code: 'validation_failed',
      message: 'Some of the information provided is not valid.',
      details: error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }

  if (error instanceof AuthorizationError) {
    // `out_of_scope` deliberately becomes a 404, not a 403. A 403 would confirm
    // the record exists, which is exactly what an IDOR probe is looking for.
    if (error.reason === 'out_of_scope') {
      return {
        statusCode: 404,
        code: 'not_found',
        message: 'Not found.',
        internal: error.detail,
      };
    }
    if (error.reason === 'step_up_required' || error.reason === 'step_up_expired') {
      return {
        statusCode: 403,
        code: 'step_up_required',
        message: error.message,
        internal: error.detail,
      };
    }
    return {
      statusCode: 403,
      code: 'forbidden',
      message: error.message,
      internal: error.detail,
    };
  }

  if (error instanceof TokenError) {
    return {
      statusCode: 401,
      code: error.reason === 'expired' ? 'token_expired' : 'unauthorized',
      message: error.reason === 'expired' ? 'Your session has expired.' : 'Sign in to continue.',
    };
  }

  if (error instanceof MfaError) {
    // Every wrong-factor outcome collapses to one message. A caller must not be
    // able to tell a wrong code from a correct-but-already-used one, or from a
    // code belonging to an account that is not enrolled — each of those would
    // confirm something useful to someone replaying a captured code.
    const invalidFactor = new Set(['invalid_code', 'replayed_code', 'not_enrolled']);
    if (invalidFactor.has(error.reason)) {
      return {
        statusCode: 400,
        code: 'mfa_invalid_code',
        message: 'That code is not correct.',
        internal: `mfa ${error.reason}`,
      };
    }

    if (error.reason === 'too_many_attempts') {
      return {
        statusCode: 429,
        code: 'mfa_too_many_attempts',
        message: 'Too many incorrect codes. Start again.',
        internal: 'mfa attempts exhausted',
      };
    }

    if (error.reason === 'challenge_not_found' || error.reason === 'challenge_expired') {
      return {
        statusCode: 401,
        code: 'mfa_challenge_invalid',
        message: 'That sign-in attempt is no longer valid. Start again.',
        internal: `mfa ${error.reason}`,
      };
    }

    if (error.reason === 'not_configured') {
      // Genuinely our fault: MFA is on but the keyring is missing.
      return {
        statusCode: 500,
        code: 'internal_error',
        message: 'Something went wrong on our side. Please try again.',
        internal: 'mfa keyring not configured',
      };
    }

    // Enrolment-state problems: safe to name, because the caller is already
    // authenticated as the account in question.
    return {
      statusCode: 409,
      code: 'mfa_enrolment_state',
      message: error.message,
      internal: `mfa ${error.reason}`,
    };
  }

  if (error instanceof PayoutDetailsError) {
    if (error.reason === 'invalid_account') {
      return { statusCode: 400, code: 'invalid_account', message: error.message };
    }
    if (error.reason === 'not_set') {
      return { statusCode: 404, code: 'not_found', message: 'Not found.', internal: 'payout not set' };
    }
    // Encryption is not configured — our fault, not the caller's, and the
    // reason is not their business.
    return {
      statusCode: 500,
      code: 'internal_error',
      message: 'Something went wrong on our side. Please try again.',
      internal: 'payout encryption not configured',
    };
  }

  if (error instanceof EnvelopeError) {
    // A decryption failure is never the caller's business. Which of wrong key,
    // wrong context, or tampering occurred is a detail that only helps someone
    // probing, so the reason goes to the log and the client gets nothing.
    return {
      statusCode: 500,
      code: 'internal_error',
      message: 'Something went wrong on our side. Please try again.',
      internal: `envelope ${error.reason}`,
    };
  }

  if (error instanceof SessionError) {
    return {
      statusCode: 401,
      code: 'session_invalid',
      message: 'Your session is no longer valid. Please sign in again.',
      internal: `session ${error.reason}`,
    };
  }

  if (error instanceof OrderTransitionError) {
    return {
      statusCode: 409,
      code: 'invalid_order_transition',
      message: error.message,
    };
  }

  if (error instanceof PricingError || error instanceof MoneyError) {
    // These indicate bad input reaching the pricing engine, not a server fault.
    return {
      statusCode: 422,
      code: 'pricing_error',
      message: 'This order could not be priced. Please review it and try again.',
      internal: error.message,
    };
  }

  if (error instanceof GeoError) {
    return {
      statusCode: 400,
      code: 'invalid_location',
      message: 'That location does not look valid.',
      internal: error.message,
    };
  }

  if (error instanceof LedgerError) {
    // A ledger error means money would not balance. Never partially apply it.
    return {
      statusCode: 500,
      code: 'ledger_error',
      message: 'This payment could not be completed safely. Nothing has been charged.',
      internal: error.message,
    };
  }

  const fastifyError = error as FastifyError;
  if (fastifyError?.statusCode && fastifyError.statusCode < 500) {
    return {
      statusCode: fastifyError.statusCode,
      code: fastifyError.code ?? 'bad_request',
      message:
        fastifyError.statusCode === 429
          ? 'Too many attempts. Try again shortly.'
          : 'That request could not be processed.',
      internal: fastifyError.message,
    };
  }

  return {
    statusCode: 500,
    code: 'internal_error',
    message: 'Something went wrong on our side. Please try again.',
    internal: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const translated = translate(error);
    const requestId = request.id;

    // Log the full picture server-side, including the internal detail that the
    // client will never see.
    const logPayload = {
      requestId,
      method: request.method,
      url: request.url,
      statusCode: translated.statusCode,
      code: translated.code,
      internal: translated.internal,
      actor: request.actor?.identityId,
      err: error instanceof Error ? error : undefined,
    };

    if (translated.statusCode >= 500) {
      request.log.error(logPayload, 'request failed');
    } else {
      request.log.warn(logPayload, 'request rejected');
    }

    const body: ErrorBody = {
      error: {
        code: translated.code,
        message: translated.message,
        requestId,
        ...(translated.details === undefined ? {} : { details: translated.details }),
      },
    };

    void reply.status(translated.statusCode).send(body);
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    void reply.status(404).send({
      error: {
        code: 'not_found',
        message: 'Not found.',
        requestId: request.id,
      },
    } satisfies ErrorBody);
  });
}
