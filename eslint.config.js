import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/coverage/**',
      '**/*.d.ts',
      // The Android shell's Gradle output and the Capacitor runtime it copies
      // in. Generated, gitignored, and not ours to lint.
      'apps/mobile/android/**',
      'apps/mobile/www/**',
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
    files: ['scripts/**/*.mjs', 'apps/mobile/scripts/**/*.mjs', 'packages/db/src/seed.ts'],
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
);
