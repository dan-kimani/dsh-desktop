#!/usr/bin/env node
/**
 * setup.mjs — assemble the bundled runtime for the host platform.
 *
 * This is the local equivalent of the release workflow's
 * `resolve-version` → `fetch-runtime` → `trim-runtime` → `prepare-bundle`
 * sequence. Keeping it in one place matters because the bundler never resolves
 * anything itself: `tauri build` bundles whatever already sits in `runtime/`, so
 * a step missed here ships silently as a stale payload.
 *
 * Usage:
 *   node scripts/setup.mjs                 # use the configured npm dist-tag
 *   node scripts/setup.mjs --version 0.1.6 # pin an exact upstream version
 *   node scripts/setup.mjs --no-node       # dsh tree only, no Node sidecar
 *   node scripts/setup.mjs --keep-cache    # keep the npm cache afterwards
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const MARKER = join(ROOT, '.dsh-version');

/**
 * Read the version the wrapper last assembled.
 * @returns {string} the marker contents, or `0.0.0` when absent
 */
export function readMarker() {
  try {
    return readFileSync(MARKER, 'utf8').trim();
  } catch {
    return '0.0.0';
  }
}

/** Run one pipeline step, inheriting stdio so its output stays visible. */
function step(script, args = []) {
  console.log(`\n$ node scripts/${script} ${args.join(' ')}`.trimEnd());
  const result = spawnSync('node', [join(ROOT, 'scripts', script), ...args], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${script} exited with code ${result.status}`);
  }
}

/**
 * Assemble the runtime: resolve the version, fetch the tree, trim it, and stage
 * it for the bundler.
 *
 * The resolved version is passed to `fetch-runtime` rather than re-resolved
 * there, so a registry change mid-run cannot install a different build than the
 * one that was recorded in `.dsh-version`.
 *
 * @param {object} [options]
 * @param {string} [options.version] - pin an exact upstream version
 * @param {boolean} [options.node] - stage the Node sidecar (default true)
 * @param {boolean} [options.keepCache] - keep the npm cache afterwards
 * @returns {string} the assembled upstream version
 */
export function assemble({ version: pinned, node = true, keepCache = false } = {}) {
  step('resolve-version.mjs', [...(pinned ? ['--force', pinned] : []), '--write']);

  const version = readMarker();
  const fetchArgs = ['--version', version];
  if (!node) fetchArgs.push('--no-node');
  if (keepCache) fetchArgs.push('--keep-cache');

  step('fetch-runtime.mjs', fetchArgs);
  step('trim-runtime.mjs');
  step('prepare-bundle.mjs');

  console.log(`\nruntime assembled: dsh ${version}`);
  return version;
}

/**
 * Pull build-wrapper flags out of an argument list, leaving everything else for
 * the Tauri CLI.
 *
 * `--latest` is ours, not the CLI's: consuming it here is what keeps it from
 * being forwarded and rejected as an unknown option.
 *
 * `npm run build --latest` never reaches this function as an argument. npm parses
 * `--latest` as one of its own config flags and only forwards arguments that follow a
 * literal `--`, so the wrapper would run without assembling anything and silently bundle
 * the payload already on disk. npm does record what it consumed, as `npm_config_latest`,
 * so both spellings are honoured rather than one failing quietly.
 *
 * @param {string[]} argv - arguments after the script name
 * @param {NodeJS.ProcessEnv} [env] - environment to read npm's config from
 * @returns {{latest: boolean, rest: string[]}}
 */
export function parseBuildArgs(argv, env = process.env) {
  const rest = [];
  let latest = env.npm_config_latest === 'true' || env.npm_config_latest === '1';
  if (latest) console.log('build: --latest came through npm config (no `--` separator)');
  for (const arg of argv) {
    if (arg === '--latest') latest = true;
    else rest.push(arg);
  }
  return { latest, rest };
}

/**
 * Run the assembler, then stamp the version into the generated build inputs.
 *
 * Called only when `--latest` is passed, so a plain build keeps bundling the
 * payload already on disk.
 */
export function assembleAndStamp() {
  const version = assemble();
  step('set-version.mjs', [version]);
}

/** Standalone entry point: `node scripts/setup.mjs`. */
function main() {
  const args = { version: undefined, node: true, keepCache: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--version') args.version = argv[++i];
    else if (argv[i] === '--no-node') args.node = false;
    else if (argv[i] === '--keep-cache') args.keepCache = true;
    else throw new Error(`unknown argument ${JSON.stringify(argv[i])}`);
  }
  assemble(args);
}

// Imported by the build wrappers, executed when run directly. Compare resolved
// file URLs rather than raw paths so a symlinked scripts directory still runs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
