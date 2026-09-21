/**
 * host-prebuild.mjs — name the current platform the way multi-platform native
 * packages name their per-OS prebuild directories.
 *
 * Packages like `node-pty` bundle every platform's binary in one npm package
 * (`prebuilds/<platform>-<arch>`), which npm cannot filter per target. The
 * trim step drops every directory that does not match the host, and the smoke
 * test asserts only the host directory survived. One definition here so the
 * two cannot drift apart.
 *
 * @returns {string} e.g. `linux-x64`
 */
export function hostPrebuildKey() {
  return `${process.platform}-${process.arch}`;
}
