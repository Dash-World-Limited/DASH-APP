/**
 * Request bodies are handed to the API client as values, never as JSON text.
 *
 * `apiFetch` serialises `options.body` itself:
 *
 *     body: JSON.stringify(options.body)
 *
 * so a caller that passes `JSON.stringify({ ... })` gets it stringified twice.
 * What reaches the server is a JSON *string* containing JSON — `"{\"a\":1}"`
 * rather than `{"a":1}` — and every schema on the far side rejects it as the
 * wrong type. The request is well-formed, the network call succeeds, and the
 * failure surfaces as a validation error about a field the user filled in
 * correctly, which is why this went unnoticed across seven call sites.
 *
 * It was found in `Become a seller` and fixed there first. The same mistake was
 * live in the buyer's contact request and in five admin actions — seller
 * decisions, document review, submission transitions and both pricing
 * workspaces — so the marketplace could not approve a seller or publish a
 * listing.
 *
 * The behavioural test below pins what `apiFetch` does with a body. The source
 * scan after it is the one that actually prevents recurrence: this is a mistake
 * that looks correct at the call site, so catching it needs a check that reads
 * every call site rather than one that exercises a single path.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiFetch } from './api.js';

const here = dirname(fileURLToPath(import.meta.url));
const webSrc = join(here, '..');

describe('apiFetch serialises the body exactly once', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends an object body as a JSON object', async () => {
    await apiFetch('/v1/declutter/seller', {
      method: 'POST',
      body: { displayName: 'Ada', publicArea: 'Lekki' },
    });

    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const sent = (call?.[1] as RequestInit | undefined)?.body;

    expect(typeof sent).toBe('string');
    const parsed: unknown = JSON.parse(sent as string);

    // The decisive assertion. Double-encoding also yields a string here, but
    // parsing it once returns *another string* rather than an object.
    expect(typeof parsed).toBe('object');
    expect(parsed).toEqual({ displayName: 'Ada', publicArea: 'Lekki' });
  });

  it('would have caught the double-encoded form', async () => {
    // What the broken call sites did, to prove this test can tell them apart.
    await apiFetch('/v1/declutter/seller', {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Ada' }) as unknown as object,
    });

    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const sent = (call?.[1] as RequestInit | undefined)?.body;
    const parsed: unknown = JSON.parse(sent as string);

    expect(typeof parsed).toBe('string');
  });

  it('omits the body entirely when there is none', async () => {
    await apiFetch('/v1/auth/logout', { method: 'POST' });

    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((call?.[1] as RequestInit | undefined)?.body).toBeUndefined();
  });
});

/** Every .ts/.tsx file under apps/web/src, except this one. */
function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
    } else if (['.ts', '.tsx'].includes(extname(entry)) && !full.endsWith('request-body.test.ts')) {
      found.push(full);
    }
  }
  return found;
}

describe('no call site double-encodes a request body', () => {
  it('nothing passes JSON.stringify as a body to the API client', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(webSrc)) {
      const source = readFileSync(file, 'utf8');

      source.split('\n').forEach((line, index) => {
        // `apiFetch` itself is the one place that legitimately stringifies,
        // and it does so on `options.body`.
        if (/\bbody:\s*JSON\.stringify\(/.test(line) && !/options\.body/.test(line)) {
          offenders.push(`${file.slice(webSrc.length + 1)}:${index + 1}`);
        }
      });
    }

    expect(offenders, `double-encoded request bodies:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });
});
