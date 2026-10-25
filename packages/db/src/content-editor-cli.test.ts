import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
describe('content editor CLI preflight never connects to an unapproved database', () => {
  it.each([
    { flags: {}, url: 'postgresql://localhost:1/dashdb_staging', args: [] },
    { flags: { DASH_PROVISION_CONTENT_EDITOR: 'YES', DASH_STAFF_EMAIL_VERIFIED: 'YES' }, url: 'postgresql://localhost:1/dashdb_production', args: [] },
    { flags: { DASH_PROVISION_CONTENT_EDITOR: 'YES', DASH_STAFF_EMAIL_VERIFIED: 'YES' }, url: 'postgresql://localhost:1/dashdb_staging', args: [] },
    { flags: { DASH_PROVISION_CONTENT_EDITOR: 'YES', DASH_STAFF_EMAIL_VERIFIED: 'YES' }, url: 'postgresql://localhost:1/dashdb_staging', args: ['--password=must-never-be-accepted'] },
  ])('refuses missing intent, wrong target, non-TTY input or arguments', ({ flags, url, args }) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/provision-content-editor.mjs', ...args], {
      cwd: root,
      env: { ...process.env, DASH_PROVISION_CONTENT_EDITOR: '', DASH_STAFF_EMAIL_VERIFIED: '', ...flags, DATABASE_URL: url },
      input: '', encoding: 'utf8', timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('Content editor provisioning stopped.');
    expect(result.stderr).not.toContain(url);
    expect(result.stderr).not.toContain('must-never-be-accepted');
    expect(result.stdout).not.toContain('Created');
  });
});
