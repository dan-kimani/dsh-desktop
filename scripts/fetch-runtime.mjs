#!/usr/bin/env node
/**
 * fetch-runtime.mjs — materialise the bundled dsh runtime for the HOST platform.
 *
 * Produces two things:
 *   1. runtime/                                   the dsh dependency tree (Tauri resource)
 *   2. src-tauri/binaries/node-<rustTriple>[.exe] the Node sidecar (Tauri externalBin)
 *
 * Everything is resolved for the host platform, so this MUST run on each target OS
 * rather than cross-compiling: `koffi`, `node-pty` and `sharp` ship per-platform
 * prebuilt addons, and npm installs only the variant matching the current platform.
 * The Node binary is platform-specific for the same reason.
 *
 * Usage:
 *   node scripts/fetch-runtime.mjs                       # tag from config/runtime.json
 *   node scripts/fetch-runtime.mjs --version 0.1.5-rc.2
 *   node scripts/fetch-runtime.mjs --node-version 24.21.0
 *   node scripts/fetch-runtime.mjs --no-node             # dsh tree only
 *   node scripts/fetch-runtime.mjs --keep-cache
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getJson, getRaw } from './fetch-json.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'config', 'runtime.json'), 'utf8'));
const RUNTIME_DIR = join(ROOT, 'runtime');
const BINARIES_DIR = join(ROOT, 'src-tauri', 'binaries');
const NPM_CACHE = join(ROOT, '.npm-cache');

/**
 * Map the host platform/arch onto everything the rest of the script needs.
 *
 * `rustTriple` is Tauri's externalBin suffix, `nodeOs`/`nodeArch` name the Node
 * distribution, `indexKey` is how nodejs.org lists that build in index.json, and
 * `ext` is the executable suffix. These differ per platform in ways that are easy
 * to conflate: macOS tarballs are named `darwin-<arch>` while index.json calls
 * them `osx-<arch>-tar`, and Windows lists `.zip`/`.7z`/`.exe`/`.msi` variants.
 *
 * @returns {{rustTriple: string, nodeOs: string, nodeArch: string, indexKey: string, ext: string}}
 */
function hostTriple() {
  const { platform, arch } = process;
  const table = [
    ['linux', 'x64', 'x86_64-unknown-linux-gnu', 'linux', 'x64', 'linux-x64', ''],
    ['linux', 'arm64', 'aarch64-unknown-linux-gnu', 'linux', 'arm64', 'linux-arm64', ''],
    ['win32', 'x64', 'x86_64-pc-windows-msvc', 'win', 'x64', 'win-x64-zip', '.exe'],
    ['win32', 'arm64', 'aarch64-pc-windows-msvc', 'win', 'arm64', 'win-arm64-zip', '.exe'],
    ['darwin', 'arm64', 'aarch64-apple-darwin', 'darwin', 'arm64', 'osx-arm64-tar', ''],
    ['darwin', 'x64', 'x86_64-apple-darwin', 'darwin', 'x64', 'osx-x64-tar', ''],
  ];
  for (const [os, cpu, rustTriple, nodeOs, nodeArch, indexKey, ext] of table) {
    if (platform === os && arch === cpu) return { rustTriple, nodeOs, nodeArch, indexKey, ext };
  }
  throw new Error(
    `unsupported host ${platform}/${arch}. Supported: Linux and Windows (x64, arm64) and macOS (arm64, x64). ` +
      `Run the build on the target OS — the runtime cannot be cross-assembled, because the payload contains ` +
      `platform-specific native addons and a platform-specific Node binary.`,
  );
}

/**
 * Run a command, inheriting stdio so build output stays visible.
 *
 * `shell` is off by default: enabling it would hand our arguments to `cmd.exe` on
 * Windows, where the quoted `-LiteralPath '<path>'` form passed to PowerShell is
 * re-parsed and breaks. Only `npm` needs it — on Windows npm is a `.cmd` shim, and
 * a shell-less spawn does not consult `PATHEXT`, so it fails with ENOENT.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {object} [options] - spawn options; `cwd` defaults to the repo root
 */
function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`);
  const needsShell = process.platform === 'win32' && command === 'npm';
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: ROOT,
    shell: needsShell,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`);
}

/**
 * Pick the newest published Node release that provides this platform's artifact.
 * @param {number} major - Node major version
 * @param {string} indexKey - the host's nodejs.org file key, e.g. `osx-arm64-tar`
 * @param {string} nodeArch - the architecture, for error messages
 * @returns {Promise<object>} the index.json entry
 */
async function resolveNodeVersion(major, indexKey, nodeArch) {
  const releases = await getJson('https://nodejs.org/dist/index.json');
  const candidates = releases.filter(
    (release) =>
      release.version.startsWith(`v${major}.`) &&
      release.lts &&
      // Filter on the host's own artifact: a release can exist for one platform
      // while another is missing or still building.
      release.files.includes(indexKey),
  );
  if (candidates.length === 0) {
    throw new Error(`no Node ${major}.x LTS release provides ${indexKey} (${nodeArch})`);
  }
  return candidates[0]; // index.json is ordered newest-first
}

/** Resolve the version to install, from config or an explicit override. */
async function resolveDshVersion(explicit) {
  if (explicit) return explicit;
  const pkg = CONFIG.npm.package.replace('/', '%2f');
  const tags = (await getJson(`https://registry.npmjs.org/${pkg}`, { registry: true }))['dist-tags'] ?? {};
  const version = tags[CONFIG.npm.tag];
  if (!version) throw new Error(`npm has no dist-tag ${JSON.stringify(CONFIG.npm.tag)} for ${CONFIG.npm.package}`);
  return version;
}

/**
 * Install the dsh dependency tree into runtime/ using production-only deps.
 * @param {string} version - exact dsh version
 * @param {boolean} keepCache - keep the npm cache afterwards
 */
function installDshTree(version, keepCache) {
  rmSync(RUNTIME_DIR, { recursive: true, force: true });
  mkdirSync(RUNTIME_DIR, { recursive: true });

  const manifest = {
    name: 'dsh-desktop-runtime',
    private: true,
    version: '0.0.0',
    dependencies: { [CONFIG.npm.package]: version },
  };
  writeFileSync(join(RUNTIME_DIR, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');

  try {
    run(
      'npm',
      [
        'install',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
        // The npm cache must live inside the workspace: a read-only $HOME makes
        // the default cache location fail with EROFS on hardened runners.
        '--cache', NPM_CACHE,
      ],
      { cwd: RUNTIME_DIR },
    );
  } finally {
    if (!keepCache) rmSync(NPM_CACHE, { recursive: true, force: true });
  }

  const bin = join(RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!existsSync(bin)) {
    throw new Error(
      `dsh entry point not found at ${bin}. The npm install reported success but the package layout ` +
        `is unexpected — upstream may have changed the publish shape.`,
    );
  }
  console.log(`dsh runtime installed at ${RUNTIME_DIR}`);
}

/**
 * Download and stage the Node binary as a Tauri externalBin.
 * @param {{rustTriple: string, nodeOs: string, nodeArch: string, indexKey: string, ext: string}} target
 * @param {string|undefined} explicitVersion - pin an exact Node version
 */
async function stageNode(target, explicitVersion) {
  const { rustTriple, nodeOs, nodeArch, indexKey, ext } = target;
  const release = explicitVersion
    ? { version: `v${explicitVersion}` }
    : await resolveNodeVersion(CONFIG.node.major, indexKey, nodeArch);
  const version = release.version.replace(/^v/, '');
  console.log(`Node ${version} (${nodeOs}-${nodeArch}) for target ${rustTriple}`);

  mkdirSync(BINARIES_DIR, { recursive: true });
  // Windows distributions are zip archives; everything else is a tarball. The
  // macOS tarball is named `darwin-<arch>` even though index.json calls the
  // build `osx-<arch>-tar`.
  const archiveExt = nodeOs === 'win' ? 'zip' : nodeOs === 'darwin' ? 'tar.gz' : 'tar.xz';
  const base = `node-v${version}-${nodeOs}-${nodeArch}`;
  const url = `https://nodejs.org/dist/v${version}/${base}.${archiveExt}`;
  const archivePath = join(BINARIES_DIR, `${base}.${archiveExt}`);

  console.log(`downloading ${url}`);
  const response = await getRaw(url);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`nodejs.org returned HTTP ${response.status} for ${url}`);
  }
  writeFileSync(archivePath, response.body);

  // Extract with tools present on each platform. Windows has no guaranteed `tar`;
  // macOS ships bsdtar, which handles both gzip and xz.
  if (nodeOs === 'win') {
    run('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${BINARIES_DIR}' -Force`,
    ]);
  } else {
    run('tar', [archiveExt === 'tar.gz' ? '-xzf' : '-xJf', archivePath, '-C', BINARIES_DIR]);
  }

  const extracted = join(BINARIES_DIR, base, nodeOs === 'win' ? 'node.exe' : 'bin/node');
  if (!existsSync(extracted)) throw new Error(`extracted Node binary not found at ${extracted}`);

  // Tauri requires the -<rustTriple> suffix, and on Windows the .exe extension
  // comes AFTER the triple: node-x86_64-pc-windows-msvc.exe
  const sidecar = join(BINARIES_DIR, `node-${rustTriple}${ext}`);
  renameSync(extracted, sidecar); // handles cross-device moves on every platform
  if (nodeOs !== 'win') run('chmod', ['+x', sidecar]);

  rmSync(join(BINARIES_DIR, base), { recursive: true, force: true });
  rmSync(archivePath, { force: true });
  console.log(`staged sidecar ${sidecar}`);
  console.log(`node version: ${version}`);
}

function parseArgs(argv) {
  const args = { version: undefined, nodeVersion: undefined, node: true, keepCache: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--version') args.version = argv[++i];
    else if (arg === '--node-version') args.nodeVersion = argv[++i];
    else if (arg === '--no-node') args.node = false;
    else if (arg === '--keep-cache') args.keepCache = true;
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const target = hostTriple();
const version = await resolveDshVersion(args.version);

console.log(`host triple: ${target.rustTriple}`);
console.log(`installing ${CONFIG.npm.package}@${version}`);

installDshTree(version, args.keepCache);
if (args.node) await stageNode(target, args.nodeVersion);

console.log(`\nruntime ready: dsh ${version}, target ${target.rustTriple}`);
