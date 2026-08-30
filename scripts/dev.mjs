/**
 * Dev runner.
 *
 * Starts the API (and, once it exists, the web app) as child processes with
 * prefixed output, and shuts them both down cleanly on Ctrl-C.
 *
 * This replaces what Turborepo's `dev` task would do (ADR-0001). It is small
 * enough to stay obvious and has no dependencies.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const COLOURS = ['[36m', '[35m', '[33m'];
const RESET = '[0m';

const targets = [
  { name: 'api', cwd: join(root, 'apps', 'api'), args: ['tsx', 'watch', '--clear-screen=false', 'src/main.ts'] },
  { name: 'web', cwd: join(root, 'apps', 'web'), args: ['next', 'dev', '--port', '3000'] },
].filter((target) => existsSync(target.cwd));

if (targets.length === 0) {
  console.error('Nothing to run — no apps found under apps/.');
  process.exit(1);
}

const children = [];

for (const [index, target] of targets.entries()) {
  const colour = COLOURS[index % COLOURS.length];
  const prefix = `${colour}[${target.name}]${RESET} `;

  const child = spawn('npx', target.args, {
    cwd: target.cwd,
    shell: process.platform === 'win32',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const forward = (stream, sink) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) sink.write(`${prefix}${line}\n`);
    });
  };

  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited with code ${code}\n`);
    // If one process dies, take the others down too rather than leaving a
    // half-running stack that looks healthy.
    shutdown(code ?? 1);
  });

  children.push(child);
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`\nRunning: ${targets.map((t) => t.name).join(', ')}\nPress Ctrl-C to stop.\n`);
