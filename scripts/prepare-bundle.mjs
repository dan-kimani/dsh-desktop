#!/usr/bin/env node
/**
 * prepare-bundle.mjs — stage the trimmed runtime where Tauri expects it, and emit
 * the wrapper's profile patch overlay.
 *
 * Tauri's `bundle.resources` maps a repo path onto a destination inside the
 * installed app. We stage a copy rather than pointing Tauri at `../runtime`
 * directly so we can guarantee the payload is complete and self-consistent before
 * the bundler walks it (a missing file at bundle time produces a broken app whose
 * only symptom is a blank window).
 *
 * The generated patch is the wrapper's own overlay on the `web` template. It is
 * deliberately minimal: the fewer rows this wrapper overrides, the less it can
 * drift from upstream across releases.
 *
 * Usage:
 *   node scripts/prepare-bundle.mjs
 *   node scripts/prepare-bundle.mjs --clean     # remove staged resources only
 */
import { cpSync, mkdirSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'runtime');
const STAGE = join(ROOT, 'src-tauri', 'resources', 'runtime');

const clean = process.argv.includes('--clean');
if (clean) {
  rmSync(join(ROOT, 'src-tauri', 'resources'), { recursive: true, force: true });
  console.log('removed src-tauri/resources');
  process.exit(0);
}

const entry = join(SOURCE, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
if (!existsSync(entry)) {
  console.error(`runtime is not prepared: ${entry} does not exist.`);
  console.error('Run `node scripts/fetch-runtime.mjs` first.');
  process.exit(1);
}

/**
 * The wrapper deliberately ships NO profile patch overlay.
 *
 * Everything the desktop shell needs — the loopback bind, the OS-assigned port,
 * and the suppressed browser handoff — is already expressible as launcher flags,
 * so restating config rows here would only create drift against upstream across
 * releases. If a future version genuinely needs to override a row, add it then and
 * remember that a patch replaces the row's WHOLE config.
 */

/** Fail loudly if the staged payload looks structurally wrong. */
function verifyPayload(dir) {
  const required = [
    'node_modules/@deepseek-ai/dsh/lib/bin.js',
    'node_modules/@deepseek-ai/dsh-web-app/lib/index.js',
    'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
  ];
  const missing = required.filter((rel) => !existsSync(join(dir, rel)));
  if (missing.length > 0) {
    throw new Error(`staged runtime is incomplete, missing:\n  ${missing.join('\n  ')}`);
  }
}

console.log('staging runtime for bundling…');
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(dirname(STAGE), { recursive: true });

// `dereference: true` resolves pnpm-style symlinks into real files, because the
// installer would otherwise ship dangling links.
cpSync(SOURCE, STAGE, { recursive: true, dereference: true });

verifyPayload(STAGE);

/** Total size of a directory tree. */
function sizeOf(path) {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop();
    const stats = statSync(current, { throwIfNoEntry: false });
    if (!stats) continue;
    if (stats.isDirectory()) {
      for (const name of readdirSync(current)) stack.push(join(current, name));
      total += 4096;
    } else {
      total += stats.size;
    }
  }
  return total;
}

const mb = (sizeOf(STAGE) / 1048576).toFixed(1);
console.log(`staged ${mb}MB at ${STAGE}`);
console.log('\nnext: npx --yes @tauri-apps/cli@^2 build');
