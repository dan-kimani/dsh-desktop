/** Shared helpers for the generated inputs in `src-tauri/tauri.conf.json`. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Absolute path to the Tauri config. */
export function configPath(root) {
  return join(root, 'src-tauri', 'tauri.conf.json');
}

/** Read and parse `tauri.conf.json`. */
export function readConfig(root) {
  return JSON.parse(readFileSync(configPath(root), 'utf8'));
}

/** Write `tauri.conf.json` back with stable formatting. */
export function writeConfig(root, config) {
  writeFileSync(configPath(root), JSON.stringify(config, null, 2) + '\n');
}

/**
 * Keep the `.icns` icon entry in step with the current platform.
 *
 * Tauri resolves every path in `bundle.icon` on every platform and fails the
 * bundle if one is missing — a macOS-only file listed on Linux or Windows breaks
 * the build outright. `.icns` cannot be produced off macOS (`iconutil` is the only
 * thing that writes the format), so the entry is treated as platform-dependent
 * rather than committed.
 *
 * @param {object} config - parsed tauri.conf.json, mutated in place
 * @param {string} iconsDir - absolute path to `src-tauri/icons`
 * @param {boolean} [force] - add the entry even if the file is absent
 * @returns {string[]} the icon entries that were added or removed
 */
export function syncIcnsIcon(config, iconsDir, force = false) {
  const entry = 'icons/icon.icns';
  const icons = config.bundle.icon;
  const index = icons.indexOf(entry);
  const present = force || existsSync(join(iconsDir, 'icon.icns'));
  const changed = [];

  if (present && index === -1) {
    // Keep it next to the other Apple-relevant sizes.
    const anchor = icons.indexOf('icons/128x128@2x.png');
    icons.splice(anchor === -1 ? icons.length : anchor + 1, 0, entry);
    changed.push(`add ${entry}`);
  } else if (!present && index !== -1) {
    icons.splice(index, 1);
    changed.push(`remove ${entry}`);
  }
  return changed;
}
