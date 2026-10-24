/**
 * Run the P0 journey against a real API process, on a throwaway database.
 *
 *   npm run e2e:journey
 *
 * 1. Creates a fresh SQLite database in the system temp folder and seeds it
 *    with the fictional development data.
 * 2. Starts the real API on port 4100 against it — mock payment, console
 *    email, SMS off — exactly as `npm run dev:api` would, but isolated from
 *    your .env and dev.db (both are left untouched).
 * 3. Runs scripts/e2e/journey.mjs: a customer registers and orders, the
 *    vendor accepts and prepares, a rider is dispatched, collects with the
 *    pickup code and delivers with the customer's PIN, and access control and
 *    account deletion are checked. Each step prints PASS or FAIL as it
 *    happens.
 * 4. Stops the API and deletes the database.
 *
 * Refuses to start if port 4100 is already in use, so it can never test
 * against a stale server.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4100;
const require = createRequire(import.meta.url);

const portFree = () =>
  new Promise((resolve) => {
    const probe = createServer()
      .once('error', () => resolve(false))
      .once('listening', () => probe.close(() => resolve(true)))
      .listen(PORT, '127.0.0.1');
  });

if (!(await portFree())) {
  console.error(`Port ${PORT} is already in use — refusing to test against a server this script did not start.`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'dash-e2e-'));
const env = {
  ...process.env,
  NODE_ENV: 'development',
  // One connection: see DATABASE_URL in .env.example.
  DATABASE_URL: `file:${join(work, 'journey.db').replace(/\\/g, '/')}?connection_limit=1`,
  JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'),
  JWT_REFRESH_SECRET: randomBytes(32).toString('base64url'),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  ENCRYPTION_KEY_ID: 'e2e',
  API_PORT: String(PORT),
  API_HOST: '127.0.0.1',
  PUBLIC_WEB_URL: 'http://127.0.0.1:3000',
  PAYMENT_PROVIDER: 'mock',
  EMAIL_PROVIDER: 'console',
  SMS_ENABLED: 'false',
  DEV_EXPOSE_OTP: 'true',
  RATE_LIMIT_ENABLED: 'false',
  QUEUE_PROVIDER: 'memory',
  STORAGE_PROVIDER: 'local',
  STORAGE_LOCAL_DIR: join(work, 'storage'),
  LOG_LEVEL: 'warn',
  OTP_RESEND_COOLDOWN_SECONDS: '0',
  OTP_MAX_CODES_PER_HOUR: '1000',
  JOURNEY_API: `http://127.0.0.1:${PORT}`,
};
for (const unset of ['S3_BUCKET', 'S3_ENDPOINT', 'REDIS_URL', 'RATE_LIMIT_REDIS']) delete env[unset];

function run(label, args) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`${label} failed:\n${result.stdout}\n${result.stderr}`);
    rmSync(work, { recursive: true, force: true });
    process.exit(1);
  }
}

console.log('== fresh database, seeded with fictional development data ==');
run('schema', [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', 'packages/db/prisma/schema.prisma']);
run('seed', ['--import', 'tsx', 'packages/db/src/seed.ts']);

console.log(`== starting the API on :${PORT} ==`);
const api = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/main.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let apiLog = '';
api.stdout.on('data', (chunk) => (apiLog += chunk));
api.stderr.on('data', (chunk) => (apiLog += chunk));

let exitCode = 1;
try {
  let up = false;
  for (let attempt = 0; attempt < 60 && !up; attempt += 1) {
    try {
      up = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (!up) throw new Error(`the API did not start:\n${apiLog.slice(-2000)}`);

  console.log('== journey ==');
  const journey = spawnSync(process.execPath, ['scripts/e2e/journey.mjs'], { cwd: root, env, stdio: 'inherit' });
  exitCode = journey.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  api.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    // Windows may still hold the SQLite file for a moment; it is in the temp folder.
  }
}
process.exit(exitCode);
