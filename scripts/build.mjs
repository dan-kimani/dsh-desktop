#!/usr/bin/env node
/**
 * build.mjs — build the app, resolving the Tauri CLI for you.
 *
 * A thin wrapper, kept because it gives one stable command surface: CI and the
 * npm scripts both call it, so a change to how the CLI is invoked happens in one
 * place rather than in every caller.
 *
 * By default this bundles whatever already sits in `runtime/` — the bundler does
 * not resolve the payload itself. Pass `--latest` to assemble the currently
 * published upstream release first, which is what makes the result current
 * instead of whatever the last `npm run setup` left behind.
 *
 * Usage:
 *   node scripts/build.mjs                       # everything for this OS
 *   node scripts/build.mjs --latest              # re-assemble from npm, then build
 *   node scripts/build.mjs --bundles deb,rpm     # passed through to the CLI
 *   node scripts/build.mjs --latest --no-bundle
 */
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleAndStamp, parseBuildArgs } from './setup.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const { latest, rest } = parseBuildArgs(process.argv.slice(2));

if (latest) {
  console.log('build: --latest, assembling the runtime before bundling');
  assembleAndStamp();
}

// Resolve the CLI the same way the README documents, so nothing needs installing.
const cli = spawnSync(
  'npx',
  ['--yes', '@tauri-apps/cli@^2', 'build', ...rest],
  { stdio: 'inherit', cwd: ROOT, env: process.env, shell: process.platform === 'win32' },
);

if (cli.error) throw cli.error;
process.exit(cli.status ?? 1);
