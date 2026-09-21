#!/usr/bin/env node
/**
 * build.mjs — build the app, resolving the Tauri CLI for you.
 *
 * A thin wrapper, kept because it gives one stable command surface: CI and the npm
 * scripts both call it, so a change to how the CLI is invoked happens in one place
 * rather than in every caller.
 *
 * Usage:
 *   node scripts/build.mjs                       # everything for this OS
 *   node scripts/build.mjs --bundles deb,rpm     # passed through to the CLI
 *   node scripts/build.mjs --no-bundle
 */
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Resolve the CLI the same way the README documents, so nothing needs installing.
const cli = spawnSync(
  'npx',
  ['--yes', '@tauri-apps/cli@^2', 'build', ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: ROOT, env: process.env, shell: process.platform === 'win32' },
);

if (cli.error) throw cli.error;
process.exit(cli.status ?? 1);
