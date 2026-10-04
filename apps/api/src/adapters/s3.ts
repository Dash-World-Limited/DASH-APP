/**
 * Object storage on S3, or anything that speaks its API.
 *
 * The first durable `StoragePort`. Everything it holds is either a photograph a
 * listing cannot exist without, or a government identity document somebody
 * handed over to be allowed to sell — so the two properties that matter are
 * that objects survive a redeploy, and that nothing is ever public.
 *
 * ## Nothing is public, ever
 *
 * No ACL is set, no bucket policy is assumed, and no object URL is constructed
 * by hand. Bytes leave through a presigned URL with a short life and no other
 * way. That is the same contract the local adapter has always had, and it is
 * why the bucket must be created with public access blocked: this adapter never
 * needs it, so a bucket that allows it is a bucket somebody misconfigured.
 *
 * ## Keys are ours
 *
 * The key comes from the caller's prefix and 24 random bytes, exactly as the
 * local adapter builds it. Nothing derived from a filename ever reaches a key,
 * so an upload cannot traverse a path, collide with another tenant's object, or
 * be guessed from anything the uploader controls.
 *
 * ## S3-compatible, not S3-only
 *
 * `endpoint` and `forcePathStyle` exist so this runs against MinIO, Cloudflare
 * R2, DigitalOcean Spaces or Backblaze B2 without a second adapter. The
 * difference between them is configuration, not code, and keeping it that way
 * means the storage decision stays reversible.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomBytes } from 'node:crypto';
import type { StoragePort, StoredObject } from '@dash/domain/ports';

/**
 * What may be stored. Identical to the local adapter's list on purpose: the
 * rule is about what the product accepts, not about where it happens to land.
 */
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export interface S3StorageOptions {
  bucket: string;
  region: string;
  /** Set for anything that is not AWS S3 itself. */
  endpoint?: string | undefined;
  /** Required by most S3-compatible providers; harmless on AWS. */
  forcePathStyle?: boolean | undefined;
}

export class S3StorageAdapter implements StoragePort {
  readonly providerName = 's3';
  readonly isLive = true;

  private readonly client: S3Client;

  constructor(
    private readonly options: S3StorageOptions,
    client?: S3Client,
  ) {
    // Credentials come from the SDK's default chain, so an instance role works
    // and no key has to exist in the environment.
    this.client =
      client ??
      new S3Client({
        region: options.region,
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        ...(options.forcePathStyle ? { forcePathStyle: true } : {}),
      });
  }

  async put(input: { body: Buffer; contentType: string; prefix: string }): Promise<StoredObject> {
    if (!ALLOWED_MIME_TYPES.has(input.contentType)) {
      throw new Error(`Refusing to store content type ${input.contentType}`);
    }
    if (input.body.length === 0) throw new Error('Refusing to store an empty file');
    if (input.body.length > MAX_UPLOAD_BYTES) {
      throw new Error(`Upload exceeds ${MAX_UPLOAD_BYTES} bytes`);
    }

    // Random, never derived from anything the caller supplied.
    const safePrefix = input.prefix.replace(/[^a-z0-9-]/gi, '');
    const key = `${safePrefix}/${randomBytes(24).toString('hex')}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: input.body,
        ContentType: input.contentType,
        // No ACL. The bucket blocks public access and this adapter never asks
        // for an exception; presigned URLs are the only way out.
        ServerSideEncryption: 'AES256',
      }),
    );

    return { key, contentType: input.contentType, sizeBytes: input.body.length };
  }

  async signedUrl(key: string, expiresInSeconds: number): Promise<string> {
    return await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }),
    );
  }

  /**
   * Can this process actually reach the bucket?
   *
   * Used by the readiness check. A deployment whose credentials or bucket name
   * are wrong otherwise looks healthy right up until the first person uploads a
   * photograph, which is the worst possible moment to find out.
   */
  async reachable(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
      return true;
    } catch {
      return false;
    }
  }
}
