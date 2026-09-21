#!/usr/bin/env node
/**
 * smoke-test.mjs — prove the bundled runtime actually boots and serves the UI.
 *
 * This is the guard for the two upstream seams this wrapper depends on and does
 * not control:
 *
 *   1. the stdout contract  — `dsh web: http://127.0.0.1:PORT/?token=...`
 *   2. the auth handshake   — token -> 303 + Set-Cookie -> 200 HTML carrying
 *                             window.__DSH_BOOT__
 *
 * If upstream changes either, this fails the build instead of shipping a wrapper
 * whose window is permanently blank.
 *
 * Usage:
 *   node scripts/smoke-test.mjs                     # uses ./runtime
 *   node scripts/smoke-test.mjs --runtime <dir>
 *   node scripts/smoke-test.mjs --node <path-to-node>
 *   node scripts/smoke-test.mjs --keep-home         # keep the temp DSH_HOME
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';

import { hostPrebuildKey } from './lib/host-prebuild.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Locate the Node binary staged as Tauri's sidecar, so CI can smoke test exactly
 * the runtime that will ship rather than whatever `node` happens to be on PATH.
 * @returns {string | undefined} absolute path to the staged binary
 */
function findStagedNode() {
  const dir = join(ROOT, 'src-tauri', 'binaries');
  if (!existsSync(dir)) return undefined;
  const name = readdirSync(dir).find((entry) => /^node-/.test(entry));
  return name === undefined ? undefined : join(dir, name);
}

function parseArgs(argv) {
  const useBundled = process.env.DSH_SMOKE_USE_BUNDLED_NODE === '1';
  const args = { runtime: join(ROOT, 'runtime'), node: undefined, keepHome: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--runtime') args.runtime = argv[++i];
    else if (arg === '--node') args.node = argv[++i];
    else if (arg === '--keep-home') args.keepHome = true;
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (args.node === undefined) {
    if (useBundled) {
      args.node = findStagedNode();
      if (args.node === undefined) {
        throw new Error(
          'DSH_SMOKE_USE_BUNDLED_NODE=1 but no staged Node binary was found in src-tauri/binaries. ' +
            'Run scripts/fetch-runtime.mjs first.',
        );
      }
    } else {
      args.node = process.execPath;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'config', 'runtime.json'), 'utf8'));
const BIN = join(args.runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

if (!existsSync(BIN)) throw new Error(`dsh entry not found at ${BIN} — run scripts/fetch-runtime.mjs first`);
if (!existsSync(args.node)) throw new Error(`node binary not found at ${args.node}`);

const home = mkdtempSync(join(tmpdir(), 'dsh-smoke-'));
const profile = CONFIG.profile.name;
const failures = [];
let child;

/** Record a check result, printing pass/fail with detail. */
function check(label, ok, detail = '') {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

/** Run a dsh invocation to completion, returning {code, stdout, stderr}. */
function runDsh(extraArgs, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const proc = spawn(args.node, [BIN, ...extraArgs], {
      env: { ...process.env, DSH_HOME: home },
      cwd: home,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

console.log(`smoke test: dsh runtime at ${args.runtime}`);
console.log(`smoke test: DSH_HOME=${home}\n`);

try {
  // ── Step 1: bootstrap the dedicated profile from the shipped web template ──
  // `--dump-config` makes this a create-then-exit operation; it also proves the
  // plugin tree composes, which is where a Bun-class runtime mismatch explodes.
  console.log(`1. bootstrap profile "${profile}" from template "${CONFIG.profile.sourceTemplate}"`);
  const bootstrap = await runDsh([
    '--profile', profile,
    '--from-default-profile', CONFIG.profile.sourceTemplate,
    '--dump-config',
  ]);
  check('profile bootstraps and composes', bootstrap.code === 0, `exit ${bootstrap.code}`);
  if (bootstrap.code !== 0) {
    console.log(bootstrap.stderr.slice(0, 2000));
    throw new Error('bootstrap failed; cannot continue');
  }
  const profileDir = join(home, 'profiles', profile);
  check('profile directory created', existsSync(profileDir), profileDir);

  // The trim step drops other platforms' native prebuilds; the host's must
  // have survived trimming, and its binding must load. Runs against an
  // untrimmed tree this fails — run scripts/trim-runtime.mjs first.
  const prebuildsDir = join(args.runtime, 'node_modules', 'node-pty', 'prebuilds');
  const keep = hostPrebuildKey();
  const survivors = existsSync(prebuildsDir) ? readdirSync(prebuildsDir) : [];
  check(
    'only the host prebuild survived trimming',
    survivors.length === 1 && survivors[0] === keep,
    survivors.length > 0 ? survivors.join(', ') : 'no prebuilds found',
  );
  try {
    createRequire(join(args.runtime, 'package.json'))('node-pty');
    check('host pty binding loads', true);
  } catch (error) {
    check('host pty binding loads', false, String(error?.message ?? error).slice(0, 160));
  }

  // ── Step 2: boot the server and parse the stdout URL contract ─────────────
  console.log('\n2. boot the web server and parse the pid/port/token contract');
  const launchArgs = [
    '--profile', profile,
    ...(CONFIG.launch.noOpen ? ['--no-open'] : []),
    '--port', String(CONFIG.launch.port),
    ...CONFIG.launch.extraArgs,
  ];
  console.log(`   $ node bin.js ${launchArgs.join(' ')}`);

  const pattern = new RegExp(CONFIG.stdout.urlPattern);
  let resolved;
  const urlPromise = new Promise((resolve) => (resolved = resolve));
  let stdout = '';
  let stderr = '';

  child = spawn(args.node, [BIN, ...launchArgs], {
    env: { ...process.env, DSH_HOME: home },
    cwd: home,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => {
    stdout += d;
    const match = stdout.match(pattern);
    if (match) resolved(match[1]);
  });
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  exited.then((code) => resolved(null) ?? void code);

  const url = await Promise.race([
    urlPromise,
    sleep(CONFIG.stdout.readyTimeoutMs).then(() => null),
  ]);

  if (!url) {
    console.log(stderr.slice(0, 2000) || stdout.slice(0, 2000));
    check('stdout URL contract matched', false, `no line matching ${CONFIG.stdout.urlPattern}`);
    throw new Error('server did not announce a URL');
  }
  check('stdout URL contract matched', true, url.replace(/token=[^&]+/, 'token=<redacted>'));

  const parsed = new URL(url);
  check('bound to loopback', parsed.hostname === '127.0.0.1', parsed.hostname);
  check('carries a token', parsed.searchParams.get('token') !== null);

  // ── Step 3: the auth handshake the webview performs ──────────────────────
  console.log('\n3. replay the exact webview auth handshake');
  const exchange = await fetch(url, { redirect: 'manual' });
  check('token exchange returns 303', exchange.status === 303, `status ${exchange.status}`);
  check('redirects to clean "/"', exchange.headers.get('location') === '/', exchange.headers.get('location') ?? '');

  const setCookie = exchange.headers.getSetCookie?.() ?? [];
  const cookie = setCookie[0]?.split(';')[0] ?? null;
  check('mints a session cookie', cookie !== null);
  if (cookie) {
    const attrs = setCookie[0];
    check('cookie is HttpOnly', /HttpOnly/i.test(attrs));
    check('cookie is SameSite=Strict', /SameSite=Strict/i.test(attrs));
  }

  if (cookie) {
    const index = await fetch(new URL('/', parsed.origin), {
      headers: { cookie, host: parsed.host },
    });
    const html = await index.text();
    check('authenticated index returns 200', index.status === 200, `status ${index.status}`);
    check('serves HTML', /text\/html/.test(index.headers.get('content-type') ?? ''));
    check('injects window.__DSH_BOOT__', html.includes('__DSH_BOOT__'));
    check('page is non-trivial', html.length > 5000, `${html.length} bytes`);
    check('references client modules', /@deepseek-ai\//.test(html));
  }

  // Unauthenticated access must stay closed — the wrapper's threat model.
  const anon = await fetch(new URL('/', parsed.origin));
  check('unauthenticated request is rejected', anon.status === 401, `status ${anon.status}`);
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await sleep(1000);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (!args.keepHome) rmSync(home, { recursive: true, force: true });
  else console.log(`\nkept DSH_HOME at ${home}`);
}

console.log(`\n${failures.length === 0 ? 'SMOKE TEST PASSED' : `SMOKE TEST FAILED (${failures.length}): ${failures.join(', ')}`}`);
process.exit(failures.length === 0 ? 0 : 1);
