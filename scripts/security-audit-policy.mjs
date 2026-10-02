import { spawnSync } from 'node:child_process';

const LEVEL = { low: 1, moderate: 2, high: 3, critical: 4 };

function runAudit({ cwd = '.', omit = [] } = {}) {
  const args = ['audit', '--json'];
  for (const value of omit) args.push('--omit', value);

  const result = spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  if (!result.stdout) {
    throw new Error(`npm audit produced no JSON for ${cwd}: ${result.stderr || 'unknown error'}`);
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Could not parse npm audit JSON for ${cwd}: ${String(error)}`);
  }

  if (!report.vulnerabilities || typeof report.vulnerabilities !== 'object') {
    throw new Error(`npm audit JSON for ${cwd} did not contain a vulnerabilities object`);
  }

  return report;
}

function blockingNames(report) {
  return Object.entries(report.vulnerabilities)
    .filter(([, value]) => (LEVEL[value.severity] ?? 0) >= LEVEL.high)
    .map(([name]) => name)
    .sort();
}

function assertNoBlocking(label, report) {
  const found = blockingNames(report);
  if (found.length > 0) {
    throw new Error(`${label} has unexpected high/critical advisories: ${found.join(', ')}`);
  }
  console.log(`${label}: no high/critical advisories`);
}

function assertOnlyKnown(label, report, known) {
  const found = blockingNames(report);
  const unexpected = found.filter((name) => !known.has(name));
  if (unexpected.length > 0) {
    throw new Error(`${label} has new high/critical advisories: ${unexpected.join(', ')}`);
  }

  const accepted = found.filter((name) => known.has(name));
  console.log(
    accepted.length > 0
      ? `${label}: known upstream/tooling advisories only: ${accepted.join(', ')}`
      : `${label}: no high/critical advisories`,
  );
}

// The deployed API/web process does not include dev dependencies or Firebase
// Admin's optional Firestore/Cloud Storage integrations. This is the release
// boundary that must remain clean.
const shippedRoot = runAudit({ omit: ['dev', 'optional'] });
assertNoBlocking('API/web shipped runtime', shippedRoot);

// Prisma is a development/CI CLI here. Its current @prisma/config release pins
// deepmerge-ts 7.1.5. Keep these visible, but do not let an upstream CLI-only
// advisory masquerade as a vulnerability in the deployed server.
const fullRoot = runAudit();
assertOnlyKnown(
  'Root complete toolchain',
  fullRoot,
  new Set(['prisma', '@prisma/config', 'deepmerge-ts']),
);

// Expo 57 currently packages Node-side CLI/config/code-signing tooling beneath
// the runtime package, so npm audit cannot separate those build-time modules
// from the React Native dependency graph. The release APK does not execute
// these Node modules. Keep the exact current high-severity chain allowlisted;
// any additional high/critical package fails this gate.
const fullMobile = runAudit({ cwd: 'apps/mobile' });
assertOnlyKnown(
  'Native complete dependency graph',
  fullMobile,
  new Set(['expo', '@expo/cli', '@expo/code-signing-certificates', 'node-forge']),
);
