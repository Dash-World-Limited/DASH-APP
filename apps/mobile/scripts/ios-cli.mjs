import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const commands = {
  run: ['run:ios'],
  generate: ['prebuild', '--platform', 'ios', '--clean', '--no-install'],
  bundle: ['export', '--platform', 'ios'],
};
const [action, ...args] = process.argv.slice(2);
if (!Object.hasOwn(commands, action) || args.some(arg => arg === '--platform' || arg.startsWith('--platform='))) {
  console.error('Use ios-cli.mjs run|generate|bundle; the target platform is fixed to iOS.');
  process.exit(1);
}
const cli = resolve(dirname(require.resolve('expo/package.json')), 'bin/cli');
// Keep Android-only Firebase validation out of iOS commands without changing
// the parent shell or the Android production configuration guard.
const result = spawnSync(process.execPath, [cli, ...commands[action], ...args], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  env: { ...process.env, DASH_BUILD_PLATFORM: 'ios' },
  stdio: 'inherit',
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
