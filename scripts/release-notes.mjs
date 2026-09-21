#!/usr/bin/env node
/**
 * release-notes.mjs — write the body of a GitHub release.
 *
 * The workflow previously published a fixed string, so every release read the same
 * and said nothing about what had changed. The useful part of a release body is the
 * commits since the last one, which only git knows.
 *
 * The range is taken from the previous tag matching the same prefix, so the first
 * release (no previous tag) summarises the entire history rather than being empty.
 *
 * Usage:
 *   node scripts/release-notes.mjs --version 0.1.5-rc.2 --out notes.md
 *   node scripts/release-notes.mjs --version 0.1.6 --out notes.md --prefix dsh-desktop-v
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Parse `--key value` flags.
 * @returns {Record<string,string>}
 */
function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
  }
  return flags;
}

/**
 * Run git, returning trimmed stdout or `undefined` when the command fails.
 * @param {string[]} args
 * @returns {string|undefined}
 */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

const flags = parseFlags(process.argv.slice(2));
const version = flags.version;
const out = flags.out;
const prefix = flags['prefix'] ?? 'dsh-desktop-v';

if (!version || !out) {
  console.error('usage: node scripts/release-notes.mjs --version <v> --out <path> [--prefix <tag-prefix>]');
  process.exit(2);
}

// Most recent tag for this product, by version order rather than commit order, so a
// late-published older release does not become the base.
const previousTag = git(['tag', '--list', `${prefix}*`, '--sort=-v:refname'])?.split('\n')[0] || undefined;
// Fall back to the tag that points at HEAD if the sort produced nothing usable.
const base = previousTag && git(['rev-parse', '--verify', '--quiet', previousTag]) ? previousTag : undefined;

const range = base ? `${base}..HEAD` : 'HEAD';
const log = git(['log', '--no-merges', '--pretty=format:%s|%h', range]) ?? '';
const commits = log.split('\n').filter(Boolean);

const lines = [];
lines.push(`dsh-desktop ${version}, wrapping DeepSeek Harness.`);
lines.push('');
lines.push(`Bundled runtime: \`@deepseek-ai/dsh@${version}\`.`);
lines.push('Platform-native build; each artifact contains its own Node runtime.');
lines.push('');

if (commits.length === 0) {
  // A release can legitimately carry no commits — a repackage of the same source
  // against a new upstream version. Say so rather than printing an empty section.
  lines.push(base ? `No source changes since ${base}.` : 'No commits recorded.');
} else {
  lines.push(base ? `### Changes since ${base}` : '### Initial release');
  lines.push('');
  for (const entry of commits) {
    const [subject, short] = entry.split('|');
    lines.push(`- ${subject} (\`${short}\`)`);
  }
}
lines.push('');
lines.push('Not affiliated with or endorsed by DeepSeek.');

writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${out} (${commits.length} commit(s) since ${base ?? 'the first commit'})`);
