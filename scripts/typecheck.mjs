/**
 * Typecheck every workspace.
 *
 * `tsc --build` is not used because there is no root tsconfig.json tying the
 * four projects together, and adding one would require marking each as
 * `composite`. Running each project explicitly is simpler and matches how the
 * workspaces are actually built.
 *
 * CI calls this same script rather than repeating the list, so the command a
 * developer runs locally and the command that gates a merge cannot drift apart.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const tscBin = createRequire(import.meta.url).resolve('typescript/bin/tsc');

const PROJECTS = [
  'packages/domain',
  'packages/db',
  'apps/api',
  'apps/web',
];

let failed = 0;

for (const project of PROJECTS) {
  const config = `${project}/tsconfig.json`;

  if (!existsSync(config)) {
    console.error(`  MISSING  ${config}`);
    failed += 1;
    continue;
  }

  // Invoke the tsc binary directly rather than going through `npx`. On Windows
  // `npx` needs `shell: true`, which Node deprecates when arguments are passed
  // (DEP0190) because they are concatenated rather than escaped.
  const result = spawnSync(
    process.execPath,
    [tscBin, '--noEmit', '-p', config],
    { encoding: 'utf8' },
  );

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();

  if (result.status === 0 && output === '') {
    console.log(`  clean    ${project}`);
  } else {
    console.error(`  FAIL     ${project}`);
    if (output) console.error(output);
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`\n${failed} project(s) failed to typecheck.`);
  process.exit(1);
}

console.log(`\n${PROJECTS.length} projects typecheck clean.`);
