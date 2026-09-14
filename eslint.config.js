import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/.next-dev/**',
      '**/coverage/**',
      '**/*.d.ts',
      // The Android shell's Gradle output and the Capacitor runtime it copies
      // in. Generated, gitignored, and not ours to lint.
      'apps/android-shell/android/**',
      'apps/android-shell/www/**',
      // The native app's generated output: `expo prebuild` writes android/ and
      // ios/ from app.config.ts, and Metro and the web export write the rest.
      'apps/mobile/android/**',
      'apps/mobile/ios/**',
      'apps/mobile/dist/**',
      'apps/mobile/.expo/**',
      // The PostgreSQL Prisma client, generated on demand by
      // `npm run check:postgres` into its own directory so it cannot overwrite
      // the SQLite client. Generated code, gitignored, and not ours to lint.
      'packages/db/prisma/postgres/.client/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `any` defeats the point of a typed money/permission model. Escaping it
      // requires an explicit disable comment naming a reason.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // --- The configuration boundary -----------------------------------------
    //
    // Secrets enter this system in exactly one place. `loadConfig` validates
    // every variable at boot, refuses an unsafe production configuration, and
    // hands the rest of the code a typed object. A `process.env` read anywhere
    // else skips all of that: no validation, no production guard, no entry in
    // the classification table that drives log redaction and the leak tests.
    //
    // Which is not hypothetical — the development seed used to read
    // `ENCRYPTION_KEY` directly and assembled a keyring with weaker rules than
    // the API applies. This rule is what stops the next one.
    //
    // The allowlist below is the boundary itself, plus files that are Node
    // programs rather than application runtime. Adding to it is a decision, and
    // the diff makes it a visible one.
    files: ['**/*.ts', '**/*.tsx'],
    ignores: [
      'apps/api/src/config.ts',
      'apps/api/src/__tests__/**',
      'apps/web/src/**',
      'packages/db/src/index.ts',
      'packages/db/src/seed.ts',
      // Runs the seed as a subprocess and has to hand it a `DATABASE_URL`
      // pointing at a throwaway file. That is building a child environment,
      // not reading application configuration, which is what the rule guards
      // against — the same reason the API's own test directory is listed.
      'packages/db/src/seed.test.ts',
      // Same reason: it pushes the schema into a throwaway SQLite file and
      // hands the child process a `DATABASE_URL` for it.
      'packages/db/src/seed-declutter.test.ts',
      // Same reason again: it runs scripts/postgres-check.mjs as a subprocess
      // with a deliberately unsafe `PG_CHECK_URL`, to prove the script refuses
      // a production database name before reaching any Prisma command.
      'packages/db/src/postgres-check-guard.test.ts',
      // Expo's build-time configuration. It runs in Node while a binary is
      // being built — never in the app — and its whole job is to read the
      // build variables (APP_VARIANT, EXPO_PUBLIC_API_URL, the Android maps
      // key) and bake them into the native project. None is a server secret:
      // the maps key is compiled into every APK by design and restricted by
      // package signature in Google Cloud, not by secrecy.
      'apps/mobile/app.config.ts',
    ],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Read configuration through loadConfig() in apps/api/src/config.ts. It validates at boot, enforces the production guards, and classifies the value in apps/api/src/secrets/classification.ts so it is redacted from logs.',
        },
      ],
    },
  },
  {
    // Tests may reach for shapes the production rules forbid.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
  {
    // Developer scripts are Node programs whose whole job is printing to a
    // terminal, so `console` and the Node globals are expected here.
    files: ['scripts/**/*.mjs', 'apps/android-shell/scripts/**/*.mjs', 'apps/mobile/scripts/**/*.mjs', 'packages/db/src/seed.ts'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Metro's configuration, which Metro loads with `require` — CommonJS by
    // the bundler's contract, not by choice.
    files: ['apps/mobile/metro.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', __dirname: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // The same kind of program, written as CommonJS so it can `require` the
    // Prisma client directly on a staging host with no build step —
    // `scripts/setup-asaba-staging.cjs` is the first. `require` and `module`
    // are how such a file works rather than a mistake, so they are declared
    // here instead of the rule being relaxed anywhere else.
    files: ['scripts/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
