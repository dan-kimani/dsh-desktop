#!/usr/bin/env node
/**
 * build-macos.mjs — bundle the macOS app and disk image, tolerating a flaky DMG step.
 *
 * `bundle_dmg.sh` is the least reliable part of a macOS release. It mounts the
 * staging image, sets its appearance through Finder, then converts it, and it runs
 * under `set -e`, so any unhandled failure exits with no explanation — which is
 * exactly the `failed to run ... bundle_dmg.sh` seen in CI.
 *
 * Two things go wrong on hosted runners:
 *
 *   1. A leftover mounted volume from an earlier attempt makes the next
 *      `hdiutil attach` fail. The script has its own unmount retries, but they give
 *      up and it never clears volumes it did not create.
 *   2. The failure is transient. A clean retry usually succeeds.
 *
 * So: detach our volumes before each attempt, retry the whole build, and on final
 * failure print the volumes and the disk-image directory, because the bare error
 * from the bundler says nothing about which step actually failed.
 *
 * The `.app` is written before the DMG, so a DMG failure still leaves a usable
 * bundle on disk — this only decides whether the job is red.
 *
 * Usage:
 *   node scripts/build-macos.mjs app,dmg --product-name dsh-desktop
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ATTEMPTS = 3;

function parseFlags(argv) {
  const flags = { bundles: 'app,dmg' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--product-name') flags.productName = argv[++i];
    else rest.push(argv[i]);
  }
  flags.rest = rest;
  return flags;
}

const flags = parseFlags(process.argv.slice(2));
const productName = flags.productName ?? 'dsh-desktop';
const volume = `/Volumes/${productName}`;

/** Run a command, capturing output instead of inheriting it. */
function run(command, args) {
  return spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
}

/** Detach our mounted volume, if one is present. */
function detachVolumes() {
  if (!existsSync(volume)) return;
  console.log(`bundle: detaching leftover ${volume}`);
  // -force tolerates a busy volume; ignore failure so the build still runs.
  run('hdiutil', ['detach', volume, '-force']);
}

/** List what is mounted, for diagnosing a failure we could not avoid. */
function dumpDiagnostics() {
  console.log('\n--- bundle: diagnostics ---');
  const info = run('hdiutil', ['info']);
  const mounts = (info.stdout ?? '')
    .split('\n')
    .filter((line) => /^\/dev\/disk/.test(line.trim()))
    .slice(0, 12);
  console.log('mounted images:');
  for (const line of mounts) console.log(' ', line.trim());

  const dmgDir = join(ROOT, 'src-tauri/target/release/bundle/dmg');
  if (existsSync(dmgDir)) {
    console.log(`dmg staging dir (${dmgDir}):`);
    for (const entry of readdirSync(dmgDir)) console.log(' ', entry);
  }
  console.log('--- end diagnostics ---\n');
}

for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  detachVolumes();
  console.log(`bundle: macOS build attempt ${attempt}/${ATTEMPTS}`);

  const cli = spawnSync(
    'npx',
    ['--yes', '@tauri-apps/cli@^2', 'build', '--bundles', flags.bundles, ...flags.rest],
    { stdio: 'inherit', cwd: ROOT, env: process.env, shell: process.platform === 'win32' },
  );
  if (cli.error) throw cli.error;

  if (cli.status === 0) {
    console.log(`bundle: attempt ${attempt} succeeded`);
    process.exit(0);
  }

  console.log(`bundle: attempt ${attempt} failed with exit code ${cli.status}`);
  detachVolumes();
}

console.log(`bundle: all ${ATTEMPTS} attempts failed`);
dumpDiagnostics();
process.exit(1);
