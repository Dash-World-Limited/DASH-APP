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

/**
 * Return only packages that carry an actual high/critical advisory object.
 *
 * npm audit propagates severity up the dependency graph. A package such as
 * react-native can therefore be labelled "high" solely because a build-time
 * dependency beneath it is vulnerable. The advisory objects inside `via` are
 * the source of truth: propagated parents contain string links, while the
 * package that actually owns the advisory contains the advisory object.
 *
 * This keeps the exception narrow. A future direct React Native advisory would
 * appear here as `react-native` and fail the gate even if React Native is also
 * a parent of an already-known tooling advisory.
 */
function directAdvisoryRoots(report) {
  const roots = new Set();

  for (const [packageName, vulnerability] of Object.entries(report.vulnerabilities)) {
    if (!Array.isArray(vulnerability.via)) continue;

    for (const via of vulnerability.via) {
      if (!via || typeof via !== 'object') continue;
      if ((LEVEL[via.severity] ?? 0) < LEVEL.high) continue;
      roots.add(via.name ?? packageName);
    }
  }

  return roots;
}

function assertOnlyKnownAdvisoryRoots(label, report, knownRoots) {
  const affected = blockingNames(report);
  const roots = directAdvisoryRoots(report);

  // A blocking result with no advisory object is an audit shape we do not
  // understand. Fail closed rather than silently accepting it.
  if (affected.length > 0 && roots.size === 0) {
    throw new Error(
      `${label} reported high/critical packages but no advisory roots: ${affected.join(', ')}`,
    );
  }

  const unexpected = [...roots].filter((name) => !knownRoots.has(name)).sort();
  if (unexpected.length > 0) {
    throw new Error(
      `${label} has new high/critical advisory roots: ${unexpected.join(', ')}`,
    );
  }

  const accepted = [...roots].filter((name) => knownRoots.has(name)).sort();
  console.log(
    accepted.length > 0
      ? `${label}: known upstream/tooling advisory roots only: ${accepted.join(', ')}`
      : `${label}: no high/critical advisories`,
  );
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

// Expo 57 carries Node-side Metro/build and certificate tooling beneath the
// mobile dependency graph. npm audit propagates vulnerabilities in those tools
// all the way up through packages such as react-native and react-native-maps,
// even though the release APK does not execute Metro, micromatch, braces or
// node-forge.
//
// Do not allowlist those parent package names: that would hide a future real
// React Native runtime advisory. Instead permit only the current advisory
// roots that have no patched release in this toolchain. Any new advisory root
// still fails the gate.
const fullMobile = runAudit({ cwd: 'apps/mobile' });
assertOnlyKnownAdvisoryRoots(
  'Native complete dependency graph',
  fullMobile,
  new Set(['braces', 'node-forge']),
);
