#!/usr/bin/env node
/**
 * set-version.mjs — write generated build inputs into tauri.conf.json.
 *
 * The application version mirrors upstream's dsh version, so a release can never
 * ship a shell claiming a different version from the runtime it bundles. The
 * platform-dependent `.icns` entry is kept in step here too, because every build
 * runs this script before bundling.
 *
 * Usage:
 *   node scripts/set-version.mjs 0.1.5-rc.2
 *   node scripts/set-version.mjs --from-marker
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readConfig, writeConfig, syncIcnsIcon } from './lib/config-icons.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONF = join(ROOT, 'src-tauri', 'tauri.conf.json');
const MARKER = join(ROOT, '.dsh-version');

const input = process.argv[2];
if (!input) {
  console.error('usage: node scripts/set-version.mjs <version> | --from-marker');
  process.exit(2);
}

const version = input === '--from-marker' ? readFileSync(MARKER, 'utf8').trim() : input;

// tauri.conf.json must carry semver; fail before the bundler does, with a clear reason.
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`refusing to stamp ${JSON.stringify(version)}: not valid semver`);
  process.exit(1);
}

const raw = readFileSync(CONF, 'utf8');
const conf = JSON.parse(raw);
const previous = conf.version;
conf.version = version;

// Preserve the file's existing formatting and key order by only rewriting the
// version line, so review diffs stay minimal and readable.
const next = raw.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
if (!next.includes(`"${version}"`)) {
  console.error('could not locate the version field in tauri.conf.json');
  process.exit(1);
}
writeFileSync(CONF, next);

// Keep `bundle.icon` valid for this platform. Tauri resolves every listed icon on
// every platform, so a macOS-only entry listed on Linux fails the build outright.
{
  const iconsDir = join(ROOT, 'src-tauri', 'icons');
  const iconsConf = readConfig(ROOT);
  const changed = syncIcnsIcon(iconsConf, iconsDir);
  if (changed.length > 0) {
    writeConfig(ROOT, iconsConf);
    console.log(`icons: ${changed.join(', ')} (${process.platform})`);
  }
}

// Also keep Cargo.toml in step; Tauri reads the version from tauri.conf.json but a
// mismatch confuses `cargo` output and artifact naming.
const cargoPath = join(ROOT, 'src-tauri', 'Cargo.toml');
const cargo = readFileSync(cargoPath, 'utf8');
const cargoNext = cargo.replace(/^version = "[^"]*"/m, `version = "${version}"`);
if (cargoNext !== cargo) writeFileSync(cargoPath, cargoNext);

console.log(`tauri.conf.json: ${previous} -> ${version}`);
