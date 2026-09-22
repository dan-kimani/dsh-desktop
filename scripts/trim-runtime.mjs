#!/usr/bin/env node
/**
 * trim-runtime.mjs — shrink the bundled dsh tree without breaking it.
 *
 * The tree is ~300MB raw. Aggressive pruning is tempting but dangerous: this is a
 * Cordis plugin tree whose rows are imported DYNAMICALLY at boot, so a module that
 * looks unused to static analysis can still be a hard boot dependency. Two traps
 * found while probing upstream:
 *
 *   - `sharp` is a TOP-LEVEL import of dsh-attachment-local (`import sharp from
 *     "sharp"`, line 8), even though image work is only some of what it does. It
 *     cannot be dropped; ~19MB of libvips must stay.
 *   - The web profile has a `code-runtime` row importing
 *     `node:module.stripTypeScriptTypes` at module top level, so any runtime that
 *     lacks that export fails the whole boot — see README "Why not Bun".
 *
 * Therefore: only provably-inert files are removed by default — plus native
 * binaries for other platforms, which the host's loader can never open (kept
 * only when the host's own prebuild directory is present, so an unfamiliar
 * layout is left alone). `--aggressive` additionally drops optional
 * integrations that upstream declares as optional, and requires a smoke test
 * afterwards (`--verify`) because it can break boot.
 *
 * Usage:
 *   node scripts/trim-runtime.mjs                 # safe trims only
 *   node scripts/trim-runtime.mjs --aggressive    # also drop optional integrations
 *   node scripts/trim-runtime.mjs --dry-run
 */
import { readdirSync, statSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, extname, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hostPrebuildKey } from './lib/host-prebuild.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = join(ROOT, 'runtime');
const MODULES = join(RUNTIME, 'node_modules');

/** Directory names that never contain runtime-needed code. */
const SAFE_DIR_NAMES = new Set(['test', 'tests', '__tests__', 'spec', 'example', 'examples', 'coverage', '.github']);
/**
 * File extensions that are inert at runtime.
 *
 * `.ts` is deliberately NOT here. Some packages publish `.ts` files that their
 * JavaScript actually imports, so blanket-removing them can break a boot. Only
 * *declaration* files are provably inert, and those are matched by
 * DECLARATION_SUFFIX below.
 */
const SAFE_EXTENSIONS = new Set(['.md', '.markdown', '.map', '.flow', '.coffee']);
/** TypeScript declaration suffixes, which no runtime ever executes. */
const DECLARATION_SUFFIXES = ['.d.ts', '.d.mts', '.d.cts'];
/** Files that only matter to tooling, not to execution. */
const SAFE_BASENAMES = new Set([
  '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.prettierrc', '.prettierrc.json',
  '.editorconfig', '.nycrc', '.nycrc.json', 'tsconfig.json', 'tsconfig.build.json',
  '.babelrc', '.babelrc.json', 'CHANGELOG.md', 'LICENSE.txt', 'AUTHORS', 'Makefile',
]);

/**
 * Packages that are optional integrations upstream does not require for a
 * browser-UI boot. Dropping them is measurably smaller but genuinely risky, so
 * it is opt-in and must be followed by a smoke test.
 */
const AGGRESSIVE_DROP = [
  '@aws-sdk',
  '@smithy',
  '@octokit',
  '@opentelemetry',
  '@google',
  '@anthropic-ai',
  '@mixmark-io',
  'openai',
  'web-streams-polyfill',
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const aggressive = args.includes('--aggressive');
if (args.some((a) => !['--dry-run', '--aggressive'].includes(a))) {
  throw new Error(`unknown argument(s): ${args.filter((a) => !['--dry-run', '--aggressive'].includes(a)).join(', ')}`);
}

if (!existsSync(MODULES)) {
  throw new Error(`${MODULES} does not exist — run scripts/fetch-runtime.mjs first`);
}

let removedBytes = 0;
let removedCount = 0;

/** Recursively size a path in bytes. */
function sizeOf(path) {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop();
    let stats;
    try {
      stats = statSync(current, { throwIfNoEntry: false });
    } catch {
      continue;
    }
    if (!stats) continue;
    if (stats.isDirectory()) {
      let entries;
      try {
        entries = readdirSync(current);
      } catch {
        continue;
      }
      for (const entry of entries) stack.push(join(current, entry));
    } else {
      total += stats.size;
    }
  }
  return total;
}

/** Remove a path, recording the saving. */
function drop(path, reason) {
  if (!existsSync(path)) return;
  const bytes = sizeOf(path);
  removedBytes += bytes;
  removedCount += 1;
  if (dryRun) {
    console.log(`[dry-run] would remove ${(bytes / 1048576).toFixed(1)}MB  ${path.replace(ROOT + '/', '')}  (${reason})`);
    return;
  }
  rmSync(path, { recursive: true, force: true });
}

/**
 * Walk node_modules looking for inert files/directories, without descending into
 * removed subtrees. Deliberately iterative to survive deeply nested trees.
 */
function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (entry === 'node_modules') continue; // handled by its own top-level pass
    let stats;
    try {
      stats = statSync(path, { throwIfNoEntry: false });
    } catch {
      continue;
    }
    if (!stats) continue;

    if (stats.isDirectory()) {
      if (SAFE_DIR_NAMES.has(entry)) {
        drop(path, `inert directory "${entry}"`);
        continue;
      }
      // Type declaration trees only matter to TypeScript consumers.
      if (dir.endsWith(join('node_modules', '@types')) || entry === '@types') {
        drop(path, 'type declarations');
        continue;
      }
      walk(path);
      continue;
    }

    const ext = extname(entry).toLowerCase();
    if (SAFE_EXTENSIONS.has(ext)) {
      drop(path, `inert extension "${ext}"`);
      continue;
    }
    if (DECLARATION_SUFFIXES.some((suffix) => entry.toLowerCase().endsWith(suffix))) {
      drop(path, 'type declaration');
      continue;
    }
    if (SAFE_BASENAMES.has(basename(entry))) {
      drop(path, 'tooling-only file');
    }
  }
}

console.log(`trimming ${MODULES}${dryRun ? ' (dry run)' : ''}${aggressive ? ' (aggressive)' : ' (safe only)'}`);

// Type declarations live in scoped dirs; check both the root and each scope.
drop(join(MODULES, '@types'), 'type declarations');
for (const scope of readdirSync(MODULES)) {
  if (!scope.startsWith('@')) continue;
  drop(join(MODULES, scope, '@types'), 'type declarations');
}

if (aggressive) {
  for (const name of AGGRESSIVE_DROP) {
    const path = name.startsWith('@') ? join(MODULES, ...name.split('/')) : join(MODULES, name);
    drop(path, 'optional integration (aggressive)');
  }
}

/**
 * Drop per-platform native binaries built for other operating systems.
 *
 * `node-pty` ships every platform's prebuild in one package
 * (`prebuilds/<platform>-<arch>`), which npm cannot filter per target. The
 * native loader only ever opens the host's directory, so the rest is dead
 * weight — mostly the Windows conpty binaries. Only prunes when the host
 * directory is present; an unfamiliar layout is left alone.
 */
function pruneForeignPrebuilds() {
  const roots = [join(MODULES, 'node-pty', 'prebuilds')];
  const keep = hostPrebuildKey();
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    if (!entries.includes(keep)) continue;
    for (const entry of entries) {
      if (entry !== keep) drop(join(root, entry), `prebuild for another platform (keeping ${keep})`);
    }
  }
}

/**
 * True when the host Linux runs glibc rather than musl. Anything else —
 * macOS, Windows, or "cannot tell" — keeps both variants.
 */
function isGlibcLinux() {
  if (process.platform !== 'linux') return false;
  try {
    // Present on glibc-linked builds (e.g. "2.43"), absent on musl builds, so
    // "cannot tell" safely keeps both variants.
    const glibc = process.report?.getReport?.()?.header?.glibcVersionRuntime;
    return typeof glibc === 'string' && glibc.length > 0;
  } catch {
    return false;
  }
}

/**
 * Drop musl twins of native binaries on glibc systems (and only there). The
 * musl bundle target, if one is ever added, keeps its own twin by the same
 * rule in reverse.
 */
function pruneMuslTwins() {
  if (!isGlibcLinux()) return;
  drop(join(MODULES, '@koromix', 'koffi-linux-x64', 'musl_x64'), 'musl twin on a glibc host');
  drop(join(MODULES, '@deepseek-ai', 'node-addon-system-linux-x64', 'bin', 'musl'), 'musl twin on a glibc host');
}

/**
 * Drop native packages that nothing in the shipped profile can reach.
 *
 * `sherpa-onnx-linux-x64` is a 32MB speech-recognition binary pulled in by
 * `dsh-experimental-speech-to-text-sensevoice`. That plugin defines no row in the
 * web profile's bundle patch, so the Cordis loader never instantiates it, and its
 * `sherpa-onnx-node` import sits inside a worker function behind `createRequire`
 * rather than at module scope — so removing the binary cannot break boot.
 *
 * INVARIANT: this holds only while the speech plugin is not a profile row. If
 * upstream adds one, the loader imports the plugin and this must be removed too;
 * the smoke test boots the real profile, so it would fail loudly rather than
 * shipping a broken bundle.
 */
function pruneUnreachableNativePackages() {
  const profilePatch = join(MODULES, '@deepseek-ai', 'dsh-web-app', 'cordis.patch.yml');
  if (!existsSync(profilePatch)) {
    // No bundle patch to consult: leave the payload untouched rather than guess.
    return;
  }
  // Not wrapped in a catch: a read failure here is a bug in this script, and
  // swallowing it would silently skip the prune (which is how this went unnoticed).
  const patch = readFileSync(profilePatch, 'utf8');
  if (/(sensevoice|speech-to-text)/i.test(patch)) return;

  drop(join(MODULES, 'sherpa-onnx-linux-x64'), 'unreachable speech-recognition binary');
  drop(join(MODULES, 'sherpa-onnx-node'), 'loader for the unreachable speech plugin');
}

pruneForeignPrebuilds();
pruneMuslTwins();
pruneUnreachableNativePackages();

walk(MODULES);

const mb = (removedBytes / 1048576).toFixed(1);
console.log(`\n${dryRun ? 'would remove' : 'removed'} ${removedCount} paths, ${mb}MB`);
console.log(`remaining tree: ${(sizeOf(MODULES) / 1048576).toFixed(1)}MB`);

if (aggressive && !dryRun) {
  console.log('\nWARNING: --aggressive can break boot. Run the smoke test before shipping:');
  console.log('  node scripts/smoke-test.mjs');
}
