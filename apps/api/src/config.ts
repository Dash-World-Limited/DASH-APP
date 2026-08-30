/**
 * Environment configuration.
 *
 * Validated once at boot with Zod. A missing or malformed variable stops the
 * process immediately with a readable message, rather than surfacing as
 * `undefined` in a request handler three hours later.
 *
 * Several rules here exist specifically to make an unsafe production
 * configuration impossible rather than merely discouraged.
 */

import { z } from 'zod';

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    API_HOST: z.string().default('127.0.0.1'),
    PUBLIC_WEB_URL: z.string().url().default('http://127.0.0.1:3000'),

    // 32 characters is the floor for an HMAC secret worth having. The default
    // values shipped in .env.example are deliberately long enough to pass this
    // check but are rejected separately below.
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),

    OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    DEV_EXPOSE_OTP: booleanish.default('false'),

    DEFAULT_CURRENCY: z.literal('NGN').default('NGN'),
    DEFAULT_CITY_SLUG: z.string().default('lagos'),
    DEFAULT_TIMEZONE: z.string().default('Africa/Lagos'),

    PAYMENT_PROVIDER: z.enum(['mock', 'paystack']).default('mock'),
    PAYSTACK_SECRET_KEY: z.string().optional(),
    PAYSTACK_WEBHOOK_SECRET: z.string().optional(),

    MAPS_PROVIDER: z.enum(['local', 'google', 'mapbox']).default('local'),
    GOOGLE_MAPS_API_KEY: z.string().optional(),
    MAPBOX_ACCESS_TOKEN: z.string().optional(),

    SMS_PROVIDER: z.enum(['console', 'termii', 'twilio']).default('console'),
    EMAIL_PROVIDER: z.enum(['console', 'smtp']).default('console'),
    PUSH_PROVIDER: z.enum(['console', 'fcm']).default('console'),

    STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('./.storage'),

    QUEUE_PROVIDER: z.enum(['memory', 'redis']).default('memory'),
    REDIS_URL: z.string().optional(),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .superRefine((env, ctx) => {
    const fail = (path: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };

    // The two token secrets signing different token classes must differ. If they
    // are equal, a refresh token verifies as an access token — a full auth
    // bypass that is invisible until someone tries it.
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      fail('JWT_REFRESH_SECRET', 'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET');
    }

    if (env.NODE_ENV !== 'production') return;

    // --- Production-only guards ---------------------------------------------
    // Each of these is a configuration that would be a serious incident in
    // production, so the process refuses to start rather than warning.

    if (env.DEV_EXPOSE_OTP) {
      fail('DEV_EXPOSE_OTP', 'DEV_EXPOSE_OTP must be false in production — it leaks login codes');
    }

    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
      if (env[key].startsWith('replace-me')) {
        fail(key, `${key} still holds the .env.example placeholder`);
      }
    }

    if (env.DATABASE_URL.startsWith('file:')) {
      fail('DATABASE_URL', 'SQLite is development-only; production requires PostgreSQL (ADR-0003)');
    }

    if (env.PAYMENT_PROVIDER === 'mock') {
      fail('PAYMENT_PROVIDER', 'The mock payment provider must never run in production');
    }
    if (env.PAYMENT_PROVIDER === 'paystack') {
      if (!env.PAYSTACK_SECRET_KEY) fail('PAYSTACK_SECRET_KEY', 'Required when using Paystack');
      if (!env.PAYSTACK_WEBHOOK_SECRET) {
        fail('PAYSTACK_WEBHOOK_SECRET', 'Required — unsigned webhooks cannot be trusted');
      }
    }

    if (env.STORAGE_PROVIDER === 'local') {
      fail('STORAGE_PROVIDER', 'Local disk storage is development-only');
    }
    if (env.QUEUE_PROVIDER === 'memory') {
      fail('QUEUE_PROVIDER', 'The in-memory queue loses jobs on restart; production requires Redis');
    }
    if (env.QUEUE_PROVIDER === 'redis' && !env.REDIS_URL) {
      fail('REDIS_URL', 'Required when QUEUE_PROVIDER is redis');
    }
  });

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;

  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    // Written to stderr and thrown — never log the values themselves, only the
    // names of what failed.
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }

  cached = result.data;
  return cached;
}

/** Test helper. Never called in normal operation. */
export function resetConfigCache(): void {
  cached = null;
}

export const isProduction = (config: Config): boolean => config.NODE_ENV === 'production';
export const isDevelopment = (config: Config): boolean => config.NODE_ENV === 'development';

/**
 * A one-line summary of which adapters are live, printed at boot.
 *
 * This exists so nobody can mistake a mock for a working integration: if the
 * banner says `payments=mock`, no payment has ever reached a bank.
 */
export function describeAdapters(config: Config): string {
  return [
    `payments=${config.PAYMENT_PROVIDER}`,
    `maps=${config.MAPS_PROVIDER}`,
    `sms=${config.SMS_PROVIDER}`,
    `storage=${config.STORAGE_PROVIDER}`,
    `queue=${config.QUEUE_PROVIDER}`,
  ].join('  ');
}
