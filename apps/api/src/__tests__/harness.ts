/**
 * API test harness.
 *
 * Builds a real Fastify instance against a real (temporary, per-worker) SQLite
 * database and drives it with `app.inject()` — no listening socket, no ports to
 * collide, no sleeping. Every route, plugin, hook, and serializer runs exactly
 * as it does in production.
 *
 * The database is a file per Vitest worker rather than one shared file, because
 * SQLite has a single writer and parallel suites would deadlock on each other.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '@dash/domain/crypto';
import { loadConfig, resetConfigCache, type Config } from '../config.js';
import { buildServer } from '../server.js';
import { CSRF_COOKIE, CSRF_HEADER, REFRESH_COOKIE } from '../auth/cookies.js';

/** Fixed, obviously fake, and only ever used against a throwaway database. */
export const TEST_PASSWORD = 'HarnessOnly!2026';
export const TEST_EMAIL = 'harness-staff@dashapp.test';
export const TEST_PHONE = '+2347000009001';

export interface TestContext {
  app: FastifyInstance;
  prisma: PrismaClient;
  config: Config;
  identityId: string;
  close: () => Promise<void>;
}

/**
 * Environment for a test API.
 *
 * The two JWT secrets are distinct and high-entropy because `config.ts` rejects
 * anything else — the harness has to satisfy the same rules production does,
 * which is a useful check in itself.
 */
function testEnv(databaseUrl: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    JWT_ACCESS_SECRET: 'gJ7xQ2mV9wL4pR8sT1uY6zA3bC5dE0fH-access-KnMqPrSt',
    JWT_REFRESH_SECRET: 'Zx4Vn8Bq2Wr6Ty0Ui3Op5As7Df9Gh1Jk-refresh-LmNoPqRs',
    ACCESS_TOKEN_TTL_SECONDS: '900',
    REFRESH_TOKEN_TTL_SECONDS: '2592000',
    OTP_TTL_SECONDS: '300',
    OTP_MAX_ATTEMPTS: '5',
    DEV_EXPOSE_OTP: 'true',
    LOG_LEVEL: 'silent',
    PUBLIC_WEB_URL: 'http://127.0.0.1:3000',
    PAYMENT_PROVIDER: 'mock',
    MAPS_PROVIDER: 'local',
    SMS_PROVIDER: 'console',
    EMAIL_PROVIDER: 'console',
    PUSH_PROVIDER: 'console',
    STORAGE_PROVIDER: 'local',
    QUEUE_PROVIDER: 'memory',
    // Off by default: these suites sign in far more often than a real user
    // would, and the login limiter would reject them. Rate limiting has its own
    // dedicated test that turns it back on.
    RATE_LIMIT_ENABLED: 'false',
  };
}

/**
 * Create an isolated API instance with a fresh database.
 *
 * Seeds only what the auth tests need — one staff identity with a password and
 * one customer identity with a phone. The full development seed is far heavier
 * and would make every test slower for no benefit.
 */
/**
 * Path to a template database with the schema already applied.
 *
 * Built at most once per process, then copied per test context. Two reasons:
 * `prisma db push` takes seconds and would dominate the suite runtime, and a
 * file copy is atomic in a way a concurrent push is not.
 */
let templateDatabase: string | null = null;

function buildTemplateDatabase(): string {
  if (templateDatabase) return templateDatabase;

  const directory = mkdtempSync(join(tmpdir(), 'dash-template-'));
  const file = join(directory, 'template.db');

  // Invoke the Prisma CLI's JS entry point through the current Node binary
  // rather than through `npx`. On Windows, `npx` resolves to `npx.cmd`, and
  // Node 24 refuses to spawn a `.cmd` without a shell (the CVE-2024-27980
  // fix), which fails with a bare EINVAL that says nothing about the cause.
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');

  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--schema', 'packages/db/prisma/schema.prisma'],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: `file:${file}` },
      stdio: 'pipe',
    },
  );

  templateDatabase = file;
  return file;
}

export async function createTestContext(
  envOverrides: Record<string, string> = {},
): Promise<TestContext> {
  const template = buildTemplateDatabase();

  const directory = mkdtempSync(join(tmpdir(), 'dash-test-'));
  const databaseFile = join(directory, 'test.db');
  const databaseUrl = `file:${databaseFile}`;

  copyFileSync(template, databaseFile);

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  const passwordHash = await hashPassword(TEST_PASSWORD);
  const identity = await prisma.identity.create({
    data: {
      email: TEST_EMAIL,
      phone: TEST_PHONE,
      displayName: 'Harness Staff',
      passwordHash,
      roles: { create: { role: 'support_agent' } },
    },
    select: { id: true },
  });

  resetConfigCache();
  const config = loadConfig({ ...testEnv(databaseUrl), ...envOverrides });
  const app = await buildServer({ config, services: { prisma } });
  await app.ready();

  return {
    app,
    prisma,
    config,
    identityId: identity.id,
    close: async () => {
      await app.services.queue.close();
      await app.close();
      await prisma.$disconnect();
      resetConfigCache();
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Windows sometimes holds the SQLite file briefly after disconnect.
        // A leftover temp directory is not worth failing a test over.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Cookie helpers
//
// `inject()` returns raw Set-Cookie headers. These parse them the way a browser
// would, so a test can assert on the actual attributes rather than trusting
// that the code meant to set them.
// ---------------------------------------------------------------------------

export interface ParsedCookie {
  name: string;
  value: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string | null;
  path: string | null;
  maxAge: number | null;
}

export function parseSetCookies(raw: string | string[] | undefined): ParsedCookie[] {
  if (!raw) return [];
  const headers = Array.isArray(raw) ? raw : [raw];

  return headers.map((header) => {
    const parts = header.split(';').map((part) => part.trim());
    const [pair, ...attributes] = parts;
    const separator = pair?.indexOf('=') ?? -1;
    const name = separator >= 0 ? pair!.slice(0, separator) : (pair ?? '');
    const value = separator >= 0 ? pair!.slice(separator + 1) : '';

    const findAttribute = (key: string): string | null => {
      const match = attributes.find((a) => a.toLowerCase().startsWith(`${key}=`));
      return match ? match.slice(key.length + 1) : null;
    };
    const hasFlag = (key: string): boolean =>
      attributes.some((a) => a.toLowerCase() === key.toLowerCase());

    const maxAge = findAttribute('max-age');

    return {
      name,
      value,
      httpOnly: hasFlag('HttpOnly'),
      secure: hasFlag('Secure'),
      sameSite: findAttribute('samesite'),
      path: findAttribute('path'),
      maxAge: maxAge === null ? null : Number(maxAge),
    };
  });
}

export function findCookie(
  raw: string | string[] | undefined,
  name: string,
): ParsedCookie | undefined {
  return parseSetCookies(raw).find((cookie) => cookie.name === name);
}

/** Build a `Cookie` request header from a set of name/value pairs. */
export function cookieHeader(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

/**
 * Everything a client holds after signing in.
 *
 * Note what is absent: the refresh token is not in the response body, because
 * the API never puts it there. It is only ever read out of a Set-Cookie header.
 */
export interface SignedInClient {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
}

export async function signInWithPassword(
  context: TestContext,
  email: string = TEST_EMAIL,
  password: string = TEST_PASSWORD,
): Promise<SignedInClient> {
  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Sign-in failed: ${response.statusCode} ${response.body}`);
  }

  const body = response.json<{ accessToken: string; csrfToken: string }>();
  const refresh = findCookie(response.headers['set-cookie'], REFRESH_COOKIE);
  if (!refresh) throw new Error('Sign-in did not set a refresh cookie');

  return {
    accessToken: body.accessToken,
    refreshToken: refresh.value,
    csrfToken: body.csrfToken,
  };
}

/**
 * Call the refresh endpoint the way a browser would: refresh cookie, CSRF
 * cookie, and the CSRF token echoed in a header.
 */
export async function refresh(
  context: TestContext,
  client: Pick<SignedInClient, 'refreshToken' | 'csrfToken'>,
  overrides: { csrfHeader?: string | null; omitCsrfCookie?: boolean } = {},
) {
  const cookies: Record<string, string> = { [REFRESH_COOKIE]: client.refreshToken };
  if (!overrides.omitCsrfCookie) cookies[CSRF_COOKIE] = client.csrfToken;

  const headers: Record<string, string> = { cookie: cookieHeader(cookies) };
  const csrfHeader =
    overrides.csrfHeader === undefined ? client.csrfToken : overrides.csrfHeader;
  if (csrfHeader !== null) headers[CSRF_HEADER] = csrfHeader;

  return context.app.inject({ method: 'POST', url: '/v1/auth/refresh', headers });
}

/** Read a rotated client out of a successful refresh response. */
export function clientFromRefresh(response: {
  json: <T>() => T;
  headers: Record<string, unknown>;
}): SignedInClient {
  const body = response.json<{ accessToken: string; csrfToken: string }>();
  const refreshCookie = findCookie(
    response.headers['set-cookie'] as string | string[] | undefined,
    REFRESH_COOKIE,
  );
  if (!refreshCookie) throw new Error('Refresh did not set a new refresh cookie');

  return {
    accessToken: body.accessToken,
    refreshToken: refreshCookie.value,
    csrfToken: body.csrfToken,
  };
}
