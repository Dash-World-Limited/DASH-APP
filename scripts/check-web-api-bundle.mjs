/** Run after next build with the same NEXT_PUBLIC_API_URL value.
 * Check the emitted API-client chunks, not server output or an unrelated URL.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const expected = process.env.NEXT_PUBLIC_API_URL;
if (!expected || !expected.startsWith('https://')) {
  throw new Error('Set NEXT_PUBLIC_API_URL to the production HTTPS API URL before building and checking.');
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const chunks = join(root, 'apps/web/.next/static/chunks');
function javascriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? javascriptFiles(path) : entry.name.endsWith('.js') ? [path] : [];
  });
}
const apiChunks = javascriptFiles(chunks).map(path => ({ path, source: readFileSync(path, 'utf8') }))
  .filter(({ source }) => source.includes('Request cannot have both JSON body and rawBody.') && source.includes('csrf_missing'));
if (!apiChunks.length) throw new Error('No emitted browser API-client chunk found; refusing to pass without checking it.');
for (const { path, source } of apiChunks) {
  const label = relative(root, path);
  if (!source.includes(expected)) throw new Error(`${label}: production API URL is missing.`);
  if (source.includes('http://127.0.0.1:4000')) throw new Error(`${label}: development API fallback survived in the browser API chunk.`);
  if (source.includes('NEXT_PUBLIC_API_URL')) throw new Error(`${label}: browser API environment lookup was not replaced at build time.`);
  process.stdout.write(`PASS ${label}: ${expected} embedded; no localhost API fallback or unresolved env lookup.\n`);
}
