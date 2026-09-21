#!/usr/bin/env node
/**
 * make-icns.mjs — build src-tauri/icons/icon.icns from the PNG icons.
 *
 * macOS bundling needs a real `.icns`. It is a macOS-only format built by
 * `iconutil`, so it cannot be produced (or validated) on Linux or Windows, and it
 * is therefore generated on demand by macOS builds and local macOS setups rather
 * than committed.
 *
 * Not needed for a `.dmg`-less `.app`, but Tauri lists `icons/icon.icns`, so any
 * macOS bundle needs the file to exist.
 *
 * Usage:
 *   node scripts/make-icns.mjs            # skip if it already exists
 *   node scripts/make-icns.mjs --force    # rebuild
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readConfig, writeConfig, syncIcnsIcon } from './lib/config-icons.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = join(ROOT, 'src-tauri', 'icons');
const ICNS = join(ICONS, 'icon.icns');
const ICONSET = join(ICONS, 'icon.iconset');

if (process.platform !== 'darwin') {
  console.error(
    `make-icns: skipped — .icns generation needs macOS (iconutil), and this is ${process.platform}.\n` +
      `  It is only required when bundling for macOS; Linux and Windows builds do not need it.`,
  );
  // Not an error: a Linux/Windows build must still succeed without this step.
  process.exit(0);
}

if (existsSync(ICNS) && !process.argv.includes('--force')) {
  console.log(`make-icns: ${ICNS} already exists (use --force to rebuild)`);
  process.exit(0);
}

// `iconutil` expects exactly these names inside an `.iconset`.
const entries = [
  ['icon_16x16.png', '32x32.png', 16],
  ['icon_16x16@2x.png', '32x32.png', 32],
  ['icon_32x32.png', '32x32.png', 32],
  ['icon_32x32@2x.png', '128x128.png', 64],
  ['icon_128x128.png', '128x128.png', 128],
  ['icon_128x128@2x.png', '128x128@2x.png', 256],
  ['icon_256x256.png', '128x128@2x.png', 256],
  ['icon_256x256@2x.png', 'icon.png', 512],
  ['icon_512x512.png', 'icon.png', 512],
  ['icon_512x512@2x.png', 'icon.png', 1024],
];

rmSync(ICONSET, { recursive: true, force: true });
mkdirSync(ICONSET, { recursive: true });

for (const [dest, source] of entries) {
  const from = join(ICONS, source);
  if (!existsSync(from)) {
    throw new Error(`make-icns: missing source icon ${from}; expected the generated PNG set`);
  }
  copyFileSync(from, join(ICONSET, dest));
}

const result = spawnSync('iconutil', ['-c', 'icns', ICONSET, '-o', ICNS], { stdio: 'inherit' });
rmSync(ICONSET, { recursive: true, force: true });

if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`iconutil exited with code ${result.status}`);
if (!existsSync(ICNS)) throw new Error('iconutil reported success but produced no .icns');

console.log(`make-icns: wrote ${ICNS}`);

// Register it: `set-version.mjs` removes this entry on platforms that cannot
// produce a `.icns`, so macOS has to put it back.
try {
  const conf = readConfig(ROOT);
  const changed = syncIcnsIcon(conf, ICONS, true);
  if (changed.length > 0) {
    writeConfig(ROOT, conf);
    console.log(`make-icns: bundle.icon ${changed.join(', ')}`);
  }
} catch (error) {
  console.warn(`make-icns: could not update bundle.icon: ${error.message}`);
}
