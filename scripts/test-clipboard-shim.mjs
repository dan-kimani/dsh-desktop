#!/usr/bin/env node
/**
 * test-clipboard-shim.mjs — run the injected clipboard bridge against a stub DOM.
 *
 * The bridge is a JavaScript string inside src-tauri/src/clipboard.rs, so it is never
 * compiled or type-checked. Two mistakes in it fail silently at runtime, inside a webview
 * this repository cannot open: invoking the wrong Tauri command name, and dispatching the
 * synthetic paste at an element the harness editor does not listen on. Both shipped once.
 *
 * This script extracts the string that actually gets injected, runs it in a page stub, and
 * asserts the behaviour that makes the bridge work:
 *
 *   1. the invoked command is `read_clipboard_image` (the Rust name Tauri dispatches), not
 *      the `allow-read-clipboard-image` ACL slug;
 *   2. the synthetic paste reaches a listener on the focused editor, because the harness
 *      editor (Lexical) attaches its `paste` listener to the contenteditable root and never
 *      sees an event dispatched on `document`;
 *   3. the synthetic event is a `ClipboardEvent` whose `clipboardData` carries a real File;
 *   4. pastes that already carry a file, or that carry text, are left alone.
 *
 * Usage: node scripts/test-clipboard-shim.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'src-tauri', 'src', 'clipboard.rs');

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;

/** Pull the shim out of the Rust source, exactly as it will be injected. */
function extractShim() {
  const source = readFileSync(SOURCE, 'utf8');
  const match = source.match(/pub const SHIM_JS: &str = r#"([\s\S]*?)"#;/);
  if (!match) throw new Error(`could not find the SHIM_JS raw string in ${SOURCE}`);
  return match[1];
}

// ── A DOM small enough to reason about, real enough to catch a wrong target ──────────────

class TestEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles === true;
    this.cancelable = init.cancelable === true;
    this.clipboardData = init.clipboardData ?? null;
    this.target = null;
    this.currentTarget = null;
    this.defaultPrevented = false;
    this._stopped = false;
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
  stopPropagation() {
    this._stopped = true;
  }
  stopImmediatePropagation() {
    this._stopped = true;
  }
}

/** Mirrors what WebKit's ClipboardEvent constructor is asked to do. */
class ClipboardEvent extends TestEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.clipboardData = init.clipboardData ?? null;
  }
}

/** A WebKit variant that ignores the `clipboardData` init member. */
class ClipboardEventDropping extends TestEvent {}

class DataTransfer {
  constructor(text = '') {
    this.items = [];
    this.items.add = (file) => {
      this.items.push({ kind: 'file', type: file.type, getAsFile: () => file });
    };
    this._text = text;
  }
  getData() {
    return this._text;
  }
}

class Node {
  constructor(name) {
    this.name = name;
    this.parentNode = null;
    this._listeners = [];
  }
  append(child) {
    child.parentNode = this;
    return child;
  }
  addEventListener(type, fn, capture = false) {
    this._listeners.push({ type, fn, capture: capture === true });
  }
  removeEventListener(type, fn) {
    this._listeners = this._listeners.filter((l) => l.type !== type || l.fn !== fn);
  }
  dispatchEvent(event) {
    const path = [];
    for (let node = this; node; node = node.parentNode) path.push(node);
    event.target = this;

    const fire = (node, capture) => {
      event.currentTarget = node;
      for (const listener of [...node._listeners]) {
        if (event._stopped) return;
        if (listener.type === event.type && listener.capture === capture) listener.fn(event);
      }
    };

    for (const node of [...path].reverse()) {
      if (node === this) continue;
      fire(node, true);
      if (event._stopped) break;
    }
    if (!event._stopped) {
      fire(this, true);
      fire(this, false);
    }
    if (!event._stopped && event.bubbles) {
      for (const node of path.slice(1)) {
        fire(node, false);
        if (event._stopped) break;
      }
    }
    return !event.defaultPrevented;
  }
}

/**
 * Build a fresh page with the shim installed.
 * @param {Function} ClipboardEventClass constructor the page exposes
 * @param {string} nativeText text the native paste carries (`''` is the image case)
 */
function createPage(ClipboardEventClass, nativeText = '', nativeFile = null) {
  const document = new Node('#document');
  const html = new Node('html');
  const body = new Node('body');
  const editor = new Node('div');
  document.append(html);
  html.append(body);
  body.append(editor);
  document.documentElement = html;
  document.body = body;
  document.activeElement = editor;

  const invoked = [];
  const sandbox = {
    document,
    ClipboardEvent: ClipboardEventClass,
    DataTransfer,
    File,
    Event: TestEvent,
    atob,
    setTimeout,
    clearTimeout,
    console,
  };
  sandbox.window = sandbox;
  sandbox.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      invoked.push({ command, args });
      return PNG_DATA_URL;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SHIM, sandbox);

  const nativeData = new DataTransfer(nativeText);
  if (nativeFile !== null) {
    nativeData.items.add(nativeFile);
  }
  return { document, editor, invoked, nativeData, sandbox };
}

/** Let the shim's promise chain run to completion. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

// ── Assertions ──────────────────────────────────────────────────────────────────────────

let failed = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

const SHIM = extractShim();
if (SHIM.trim() === '') throw new Error('the extracted shim is empty; did SHIM_JS change shape?');

const fileItem = new File([PNG_BYTES], 'native.png', { type: 'image/png' });

// 1. The failing case the shim exists for: an image paste with no file and no text.
{
  console.log('\n1. image paste on Linux (no file item, empty text)');
  const page = createPage(ClipboardEvent);
  const delivered = [];
  page.editor.addEventListener('paste', (event) => delivered.push(event));

  const native = new ClipboardEvent('paste', {
    clipboardData: page.nativeData,
    bubbles: true,
    cancelable: true,
  });
  page.editor.dispatchEvent(native);
  check('the dropped paste is suppressed', native.defaultPrevented);

  await settle();

  check(
    'invokes the Rust command name',
    page.invoked.length === 1 && page.invoked[0].command === 'read_clipboard_image',
    `invoked ${JSON.stringify(page.invoked.map((entry) => entry.command))}`,
  );
  check('passes an argument object', typeof page.invoked[0]?.args === 'object');
  check('synthetic paste reaches the focused editor', delivered.length === 1);

  const event = delivered[0];
  check('synthetic event is a ClipboardEvent', event instanceof ClipboardEvent);
  check(
    'synthetic event satisfies Lexical isClipboardEvent()',
    event !== undefined && Object.getPrototypeOf(event).constructor.name === 'ClipboardEvent',
  );

  const items = event?.clipboardData?.items ?? [];
  const carried = items[0]?.getAsFile?.() ?? null;
  check('synthetic clipboard holds a file', carried !== null);
  check('file is the PNG the host returned', carried?.type === 'image/png' && carried?.size === PNG_BYTES.length,
    `${carried?.type} ${carried?.size}B`);
}

// 2. WebKit variants that ignore the `clipboardData` init member.
{
  console.log('\n2. ClipboardEvent constructor that drops clipboardData');
  const page = createPage(ClipboardEventDropping);
  const delivered = [];
  page.editor.addEventListener('paste', (event) => delivered.push(event));

  const native = new ClipboardEventDropping('paste', {
    clipboardData: page.nativeData,
    bubbles: true,
    cancelable: true,
  });
  page.editor.dispatchEvent(native);
  await settle();

  check('clipboardData still carries the file', delivered[0]?.clipboardData?.items?.length === 1);
}

// 3. A real file paste must be left to the platform.
{
  console.log('\n3. native file paste is left alone');
  const page = createPage(ClipboardEvent, '', fileItem);
  const delivered = [];
  page.editor.addEventListener('paste', (event) => delivered.push(event));

  const native = new ClipboardEvent('paste', {
    clipboardData: page.nativeData,
    bubbles: true,
    cancelable: true,
  });
  page.editor.dispatchEvent(native);
  await settle();

  check('does not invoke the host', page.invoked.length === 0);
  check('does not consume the event', native.defaultPrevented === false);
  check(
    'delivers only the platform paste, no synthetic copy',
    delivered.length === 1 && delivered[0] === native,
    `saw ${delivered.length} paste events`,
  );
}

// 4. Text pastes keep working through the platform.
{
  console.log('\n4. text paste is left alone');
  const page = createPage(ClipboardEvent, 'hello');
  const delivered = [];
  page.editor.addEventListener('paste', (event) => delivered.push(event));

  const native = new ClipboardEvent('paste', {
    clipboardData: page.nativeData,
    bubbles: true,
    cancelable: true,
  });
  page.editor.dispatchEvent(native);
  await settle();

  check('does not invoke the host', page.invoked.length === 0);
  check('does not consume the event', native.defaultPrevented === false);
  check('leaves the native paste to the editor', delivered.length === 1);
}

console.log(failed === 0 ? '\nCLIPBOARD SHIM TEST PASSED' : `\nCLIPBOARD SHIM TEST FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
