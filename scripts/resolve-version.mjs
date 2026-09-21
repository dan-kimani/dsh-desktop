#!/usr/bin/env node
/**
 * resolve-version.mjs — decide whether a new upstream dsh release should be built.
 *
 * Upstream ships NO GitHub release assets (all 18 releases are tag-only), so the
 * npm registry is the only machine-readable release signal. This script therefore
 * resolves the desired version from the npm dist-tag rather than from a git tag.
 *
 * It is the gate for the whole release pipeline:
 *   - resolves the target version from config/runtime.json `npm`
 *   - compares it against the committed .dsh-version marker
 *   - reports whether an update is available for the workflow to act on
 *
 * Usage:
 *   node scripts/resolve-version.mjs                 # resolve from the configured tag
 *   node scripts/resolve-version.mjs --check         # exit 10 when an update is available
 *   node scripts/resolve-version.mjs --force 0.1.6-alpha.2
 *   node scripts/resolve-version.mjs --write         # record the resolved version
 *
 * GitHub Actions outputs (also written to $GITHUB_OUTPUT when present):
 *   version, previous, updated, tauri_version
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getJson } from './fetch-json.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, 'config', 'runtime.json');
const MARKER = join(ROOT, '.dsh-version');

/** Read and parse the shared runtime config (tolerating the $comment keys). */
function loadConfig() {
  return JSON.parse(readFileSync(CONFIG, 'utf8'));
}

/** True when a string is valid semver, which is what tauri.conf.json requires. */
function isSemver(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

/**
 * Map an upstream dsh version to the wrapper's application version.
 *
 * The wrapper mirrors upstream verbatim so version numbers stay directly
 * traceable back to the release being repackaged. dsh ships prereleases as
 * `latest` (currently 0.1.5-rc.2), and semver orders a prerelease BELOW its own
 * release — so shipping `0.1.5-rc.2` and later upstream's stable `0.1.5` is a
 * forward move, but shipping `0.1.5-rc.2` and then `0.1.5-rc.3` means the
 * tauri-plugin-updater would see `rc.3 < rc.2`? It does not: prerelease
 * identifiers compare left to right, so `rc.3 > rc.2`. The real hazard is only
 * the OTHER direction, which cannot occur here because a final release always
 * outranks its own prereleases.
 *
 * What is NOT safe is build metadata (`+...`): semver ignores it for ordering,
 * so two builds sharing a base version would compare equal and an update would
 * be silently skipped. We therefore never encode a build counter in the version.
 * Use config/runtime.json to pin `--force` for a packaging-only rebuild.
 *
 * @param {string} version upstream version, e.g. "0.1.5-rc.2"
 * @returns {string} a semver string valid for tauri.conf.json
 */
function toTauriVersion(version) {
  if (!isSemver(version)) {
    throw new Error(
      `upstream version ${JSON.stringify(version)} is not valid semver, so it cannot be used as a Tauri app version`,
    );
  }
  return version;
}

/** Resolve the published version for a dist-tag, or an exact version. */
async function resolvePublished(pkg, tag) {
  const url = `https://registry.npmjs.org/${pkg.replace('/', '%2f')}`;
  const body = await getJson(url, { registry: true });
  const tags = body['dist-tags'] ?? {};
  const version = tags[tag];
  if (version === undefined) {
    throw new Error(
      `npm has no dist-tag ${JSON.stringify(tag)} for ${pkg}; available: ${Object.keys(tags).join(', ')}`,
    );
  }
  return { version, allTags: tags };
}

function parseArgs(argv) {
  const args = { check: false, write: false, force: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') args.check = true;
    else if (arg === '--write') args.write = true;
    else if (arg === '--force') args.force = argv[++i];
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  return args;
}

/** Emit GitHub Actions outputs when running in CI, and always log them. */
function setOutputs(pairs) {
  const lines = Object.entries(pairs).map(([k, v]) => `${k}=${v}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  for (const line of lines) console.log(`[output] ${line}`);
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();

const previous = existsSync(MARKER) ? readFileSync(MARKER, 'utf8').trim() : '0.0.0';
const { version } = args.force !== undefined
  ? { version: args.force }
  : await resolvePublished(config.npm.package, config.npm.tag);

const tauriVersion = toTauriVersion(version);
const updated = version !== previous;

console.log(`package:        ${config.npm.package}`);
console.log(`configured tag: ${config.npm.tag}`);
console.log(`previous:       ${previous}`);
console.log(`resolved:       ${version}`);
console.log(`tauri version:  ${tauriVersion}`);
console.log(`updated:        ${updated}`);

if (args.write) {
  writeFileSync(MARKER, `${version}\n`);
  console.log(`wrote ${MARKER}`);
}

setOutputs({ version, previous, updated: String(updated), tauri_version: tauriVersion });

// Exit 10 is a deliberate "update available" signal, distinct from any failure.
process.exit(args.check && updated ? 10 : 0);
