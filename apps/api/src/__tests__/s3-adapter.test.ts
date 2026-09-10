/**
 * The S3 adapter, without touching AWS.
 *
 * A stub client captures the commands. What these assert is the handful of
 * properties that decide whether a bucket full of identity documents is safe:
 * no object is ever made public, no key is derived from anything an uploader
 * controls, and the limits that protect the bucket are the same ones the local
 * adapter has always enforced.
 */

import { describe, expect, it } from 'vitest';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import type { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { S3StorageAdapter } from '../adapters/s3.js';

class StubClient {
  readonly sent: unknown[] = [];
  constructor(private readonly failHead = false) {}

  async send(command: unknown) {
    this.sent.push(command);
    if (command instanceof HeadBucketCommand && this.failHead) {
      throw new Error('NoSuchBucket');
    }
    return {};
  }
}

const OPTIONS = { bucket: 'dash-declutters', region: 'eu-west-1' };

function adapter(failHead = false) {
  const client = new StubClient(failHead);
  return { adapter: new S3StorageAdapter(OPTIONS, client as never), client };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

// ---------------------------------------------------------------------------

describe('storing an object', () => {
  it('reports itself as durable, unlike the local adapter', () => {
    expect(adapter().adapter.isLive).toBe(true);
    expect(adapter().adapter.providerName).toBe('s3');
  });

  it('never makes an object public', async () => {
    const { adapter: a, client } = adapter();
    await a.put({ body: PNG, contentType: 'image/png', prefix: 'declutter-items' });

    const command = client.sent[0] as PutObjectCommand;
    // No ACL at all. Bytes leave through a presigned URL and no other way,
    // which is why the bucket must block public access: this adapter never
    // needs it, so a bucket that allows it is one somebody misconfigured.
    expect(command.input.ACL).toBeUndefined();
    expect(command.input.ServerSideEncryption).toBe('AES256');
  });

  it('builds a key from the prefix and random bytes, never from input', async () => {
    const { adapter: a, client } = adapter();
    const stored = await a.put({
      body: PNG,
      contentType: 'image/png',
      prefix: 'declutter-kyc',
    });

    expect(stored.key).toMatch(/^declutter-kyc\/[0-9a-f]{48}$/);
    expect((client.sent[0] as PutObjectCommand).input.Key).toBe(stored.key);
  });

  it('gives two identical uploads two different keys', async () => {
    const { adapter: a } = adapter();
    const first = await a.put({ body: PNG, contentType: 'image/png', prefix: 'x' });
    const second = await a.put({ body: PNG, contentType: 'image/png', prefix: 'x' });
    expect(first.key).not.toBe(second.key);
  });

  it('strips anything unexpected from the prefix', async () => {
    const { adapter: a } = adapter();
    // A prefix is ours, not a caller's, but a traversal attempt must not
    // survive even so.
    const stored = await a.put({
      body: PNG,
      contentType: 'image/png',
      prefix: '../../etc/passwd',
    });
    expect(stored.key.startsWith('etcpasswd/')).toBe(true);
    expect(stored.key).not.toContain('..');
  });

  it('refuses a type the product does not accept', async () => {
    const { adapter: a } = adapter();
    await expect(
      a.put({ body: PNG, contentType: 'text/html', prefix: 'x' }),
    ).rejects.toThrow(/content type/i);
    await expect(
      a.put({ body: PNG, contentType: 'application/javascript', prefix: 'x' }),
    ).rejects.toThrow(/content type/i);
  });

  it('refuses an empty file and one over the cap', async () => {
    const { adapter: a } = adapter();
    await expect(
      a.put({ body: Buffer.alloc(0), contentType: 'image/png', prefix: 'x' }),
    ).rejects.toThrow(/empty/i);
    await expect(
      a.put({ body: Buffer.alloc(9 * 1024 * 1024), contentType: 'image/png', prefix: 'x' }),
    ).rejects.toThrow(/exceeds/i);
  });

  it('deletes by key', async () => {
    const { adapter: a, client } = adapter();
    await a.delete('declutter-items/abc');
    const command = client.sent[0] as DeleteObjectCommand;
    expect(command.input.Bucket).toBe('dash-declutters');
    expect(command.input.Key).toBe('declutter-items/abc');
  });
});

// ---------------------------------------------------------------------------

describe('readiness', () => {
  it('reports a reachable bucket', async () => {
    const { adapter: a } = adapter();
    expect(await a.reachable()).toBe(true);
  });

  it('reports an unreachable one without throwing', async () => {
    // A wrong bucket name or a missing credential is otherwise invisible until
    // the first seller photographs an item.
    const { adapter: a } = adapter(true);
    expect(await a.reachable()).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('S3-compatible providers', () => {
  it('accepts an endpoint and path-style addressing', () => {
    // MinIO, R2, Spaces and B2 differ from AWS by configuration, not by code,
    // which is what keeps the storage decision reversible.
    const built = new S3StorageAdapter({
      ...OPTIONS,
      endpoint: 'https://s3.example.com',
      forcePathStyle: true,
    });
    expect(built.providerName).toBe('s3');
  });
});
