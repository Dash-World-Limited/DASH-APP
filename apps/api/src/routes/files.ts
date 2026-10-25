/**
 * Serving a stored object through its signed URL.
 *
 * `LocalStorageAdapter.signedUrl()` has always minted `/v1/files/<key>?…`, and
 * until now nothing answered that path — so every link it produced was a 404.
 * It went unnoticed because the only caller was the KYC document link endpoint,
 * whose response is a URL an admin has not yet had to open. Item photographs
 * made it load-bearing: a marketplace whose images do not render is not a
 * marketplace.
 *
 * ## Why this route exists at all
 *
 * Object storage in production issues its own signed URLs, absolute and pointing
 * at the provider, and this route is never touched. Locally there is no
 * provider, so the API stands in for one. The route is therefore registered
 * only when the configured adapter is the local one — an S3 adapter would make
 * it dead code, and dead code that serves files is worth not having.
 *
 * ## What it does not trust
 *
 * The key comes out of a URL, so it is matched against the exact shape this
 * adapter generates — a known prefix and 48 hex characters — before anything
 * touches the disk. The adapter's own `pathFor` refuses to escape the base
 * directory as well; this is the outer of two checks, not the only one.
 *
 * The signature covers the key *and* the expiry, so a URL cannot be edited to
 * reach another object or to extend its own life.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../http/errors.js';

/**
 * Exactly what `LocalStorageAdapter.put()` produces: a sanitised prefix and 24
 * random bytes as hex. Anything else is not a key we ever issued.
 */
const KEY_PATTERN = /^[a-z0-9-]{1,40}\/[0-9a-f]{48}$/i;

const querySchema = z.object({
  expires: z.coerce.number().int().positive(),
  signature: z.string().regex(/^[0-9a-f]{64}$/),
});

/** Enough of a file to recognise it. Content type is decided from bytes. */
function sniffContentType(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
    return 'application/pdf';
  }
  return null;
}

/**
 * The subset of the local adapter this route needs.
 *
 * Structural rather than a class check, so a test can substitute its own
 * implementation without importing the adapter.
 */
interface LocallyServable {
  verifySignedUrl(key: string, expiresAt: number, signature: string): boolean;
  read(key: string): Promise<Buffer>;
}

function locallyServable(storage: unknown): LocallyServable | null {
  const candidate = storage as Partial<LocallyServable>;
  return typeof candidate?.verifySignedUrl === 'function' && typeof candidate?.read === 'function'
    ? (candidate as LocallyServable)
    : null;
}

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  const storage = locallyServable(app.services.storage);
  // A provider that issues its own absolute signed URLs never routes through
  // here, and registering a file server it does not need would be a way in
  // that nothing asked for.
  if (!storage) return;

  app.get('/v1/files/:key', async (request, reply) => {
    const { key } = z.object({ key: z.string().min(1).max(120) }).parse(request.params);
    const query = querySchema.parse(request.query);

    // Both failures answer the same way. Distinguishing "no such object" from
    // "bad signature" would let a caller confirm that a key exists.
    if (!KEY_PATTERN.test(key) || !storage.verifySignedUrl(key, query.expires, query.signature)) {
      throw ApiError.notFound();
    }

    let bytes: Buffer;
    try {
      bytes = await storage.read(key);
    } catch {
      throw ApiError.notFound();
    }

    const contentType = sniffContentType(bytes);
    if (!contentType) {
      // Something is on disk under one of our keys that is not a type we ever
      // accept. Serving it as `application/octet-stream` would still be
      // serving it, so it is simply not served.
      throw ApiError.notFound();
    }

    return reply
      .header('Content-Type', contentType)
      // Never sniffed by the browser: the type above came from the bytes, and
      // a browser second-guessing it is how an image becomes a script.
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', 'inline')
      // Editorial raster assets are deliberately embedded by the web client
      // (including a different local dev port). Keep every operational upload
      // on the existing policy; the signed URL is still required for both.
      .header('Cross-Origin-Resource-Policy', key.startsWith('content-studio/') ? 'cross-origin' : 'same-site')
      // `private` because the URL is signed and short-lived. A shared cache
      // holding it would outlive the permission that produced it.
      .header('Cache-Control', 'private, max-age=300')
      // Nothing here is a document that should be able to script or frame.
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .send(bytes);
  });
}
