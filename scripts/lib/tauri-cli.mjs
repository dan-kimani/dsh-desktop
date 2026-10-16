/**
 * tauri-cli.mjs — the one place the Tauri CLI version is pinned.
 *
 * Pinned deliberately, rather than floated as `@tauri-apps/cli@^2`. The CLI ships
 * the Rust `tauri-bundler`, which picks the `rpm` crate that writes our `.rpm`,
 * and RPM's version field may not contain `-` — it separates version from
 * release. Our application version mirrors upstream dsh, and upstream publishes
 * prereleases (`0.2.0-rc.2`), so every version we stamp contains one.
 *
 *   2.12.2 -> tauri-bundler 2.10.2 -> rpm 0.16  (no version-character check)
 *   2.12.3 -> tauri-bundler 2.10.3 -> rpm 0.30  (rejects `-`: "invalid version")
 *
 * That is not hypothetical: 2.12.3 was published 2026-10-14, and the daily run on
 * 2026-10-15 failed the linux-x64 RPM bundle on the *same commit* and the *same
 * version* that had passed on 2026-10-13. Floating `^2` turned a green build red
 * with no repo change at all.
 *
 * Pinning also keeps the other platforms reproducible: the same floating range
 * could just as easily change NSIS or DMG behaviour between two runs of one
 * commit, which is exactly the class of failure that is hardest to bisect.
 *
 * Do not bump this without deciding what happens to the `.rpm`. There is no way
 * to satisfy both constraints at once: `rpm` 0.30 wants a version field without
 * `-`, and semver puts every prerelease behind one. The real options are to stop
 * stamping a prerelease into `tauri.conf.json` (which also changes the deb, NSIS
 * and macOS versions, since they share that one field), to drop `.rpm` from the
 * matrix while tracking a prerelease channel, or to wait for upstream to relax
 * the check — which is unlikely, because the check matches the RPM spec.
 */
export const TAURI_CLI = '@tauri-apps/cli@2.12.2';
