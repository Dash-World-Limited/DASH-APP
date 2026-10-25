/** Staging-only operator CLI. No password in argv, environment, logs or files. */
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { assertContentEditorStagingTarget, provisionContentEditor } from '../apps/api/src/staff/provision-content-editor.ts';

let prisma;
async function main() {
  if (process.argv.length !== 2) throw new Error('No command-line arguments are accepted.');
  if (process.env.DASH_PROVISION_CONTENT_EDITOR !== 'YES' || process.env.DASH_STAFF_EMAIL_VERIFIED !== 'YES') {
    throw new Error('Confirm operator intent and mailbox control before provisioning.');
  }
  assertContentEditorStagingTarget(process.env.DATABASE_URL);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('An interactive private terminal is required.');
  let hidden = false;
  const output = new Writable({ write(chunk, encoding, done) { if (!hidden) process.stdout.write(chunk, encoding); done(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  rl.on('SIGINT', () => rl.close());
  let password = '';
  let confirmation = '';
  try {
    const email = await rl.question('Staff email: ');
    const displayName = await rl.question('Display name: ');
    process.stdout.write('Password (hidden, 14–256 characters): ');
    hidden = true;
    password = await rl.question('');
    process.stdout.write('\nConfirm password (hidden): ');
    confirmation = await rl.question('');
    process.stdout.write('\n');
    if (password !== confirmation) throw new Error('Passwords do not match.');
    // Use DASH's existing PostgreSQL-aware client, not a second auth store.
    ({ prisma } = await import('@dash/db'));
    const result = await provisionContentEditor(prisma, { email, displayName, password });
    console.log(`Created content_editor identity ${result.id}. Complete MFA at /studio/signin.`);
  } finally {
    password = '';
    confirmation = '';
    hidden = false;
    rl.close();
    output.end();
  }
}

main().catch(() => {
  // Do not print raw database errors, input values, connection strings or secrets.
  console.error('Content editor provisioning stopped. Check staging target, confirmations, input and duplicate identity; no additional role is granted.');
  process.exitCode = 1;
}).finally(async () => { await prisma?.$disconnect(); });
