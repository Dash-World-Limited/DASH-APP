/**
 * What went wrong, in the API's own terms.
 *
 * The server answers every failure with one envelope —
 * `{ error: { code, message, requestId } }` — and `message` is already written
 * for a person. The client keeps all three: `code` to decide what to do,
 * `message` to show, and `requestId` because it is the only thread between a
 * screen someone photographed and the line the server logged.
 *
 * Pure: no React Native, so it is tested directly.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The request never reached DASH — no signal, DNS, a timeout. */
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

interface ResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

const FALLBACK: Record<number, string> = {
  400: 'That request was not accepted.',
  401: 'Please sign in again.',
  403: 'You do not have access to that.',
  404: 'We could not find that.',
  409: 'That changed while you were looking at it. Please try again.',
  429: 'Too many attempts. Please wait a moment and try again.',
};

/** Turn a non-2xx response into an ApiError, trusting only what is well-formed. */
export async function toApiError(response: ResponseLike): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Not JSON — a proxy error page, an empty body. Fall through to defaults.
  }

  const envelope =
    body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object'
      ? (body.error as Record<string, unknown>)
      : null;

  const code = typeof envelope?.code === 'string' ? envelope.code : `http_${response.status}`;
  const message =
    typeof envelope?.message === 'string' && envelope.message.length > 0
      ? envelope.message
      : FALLBACK[response.status] ?? (response.status >= 500 ? 'DASH is having trouble right now. Please try again.' : 'Something went wrong.');
  const requestId =
    typeof envelope?.requestId === 'string' ? envelope.requestId : response.headers.get('x-request-id');

  return new ApiError(response.status, code, message, requestId);
}

export function networkError(): ApiError {
  return new ApiError(0, 'network', 'Could not reach DASH. Check your connection and try again.');
}

export function notConfiguredError(): ApiError {
  return new ApiError(0, 'not_configured', 'This build is not connected to a DASH server.');
}
