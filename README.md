# dsh-desktop

A [Tauri 2](https://v2.tauri.app/) desktop wrapper around the **DeepSeek Harness** web
application, for **Windows**, **Linux** and **macOS**, on x64 and arm64.

It ships no application code of its own. It bundles a Node runtime plus the published
`@deepseek-ai/dsh` npm package, boots `dsh --profile tauri` on a loopback port, and points a
native window at the harness UI.

```text
┌─ dsh-desktop (Tauri shell) ────────────────────────────────┐
│  Rust:  spawn sidecar → parse `dsh web: <url>` → navigate  │
│  WebView:  http://127.0.0.1:<port>  (harness UI)           │
│                                                            │
│  externalBin: node                                         │
│  resources:   runtime/  (dsh + its dependency tree)        │
└────────────────────────────────────────────────────────────┘
```

Upstream already ships an official **Electron** desktop app, and its CLI reserves the
`desktop` profile for that app alone. This wrapper is an independent Tauri shell with its own
`tauri` profile, so it never shares a plugin tree or `node_modules` with either. It does
share the harness home (`~/.dsh`) with the CLI, so sessions and credentials carry across.

## Local setup

- **Node 24** — for the build scripts. The runtime bundles its own Node.
- **Rust ≥ 1.77.2** — via [rustup](https://rustup.rs).
- **Linux** — `libwebkit2gtk-4.1-dev`, `libjavascriptcoregtk-4.1-dev`, `libgtk-3-dev`,
  `librsvg2-dev`, `libayatana-appindicator3-dev`, `patchelf`, `build-essential`, `libssl-dev`.
- **Windows** — WebView2 (preinstalled on current Windows) and the MSVC build tools.
- **macOS** — Xcode command line tools, plus `node scripts/make-icns.mjs` for the `.icns` icon.

Assemble the runtime, then confirm it boots before building anything:

```bash
npm run setup     # fetch the runtime, trim it, stage it for bundling
npm run smoke     # boot it and replay the auth handshake
```

`npm run smoke` is the fastest way to tell whether a failure is yours or upstream's, and
`DSH_SMOKE_USE_BUNDLED_NODE=1 npm run smoke` tests the staged binary that actually ships.
All of these commands are idempotent.

## Running the dev environment

```bash
npm run dev
```

| Variable           | Effect                                                                      |
| ------------------ | --------------------------------------------------------------------------- |
| `DSH_DESKTOP_HOME` | Overrides the harness home, so a test run never touches your real `~/.dsh`. |
| `DSH_DESKTOP_CWD`  | Working directory for agent sessions (defaults to your home directory).     |

The harness home defaults to `$DSH_HOME`, else `~/.dsh` — the same root the `dsh` CLI uses.
Sessions live in `$DSH_HOME/sessions/<project key>/`, grouped by their working directory, so
a desktop session joins your CLI sessions only when both started in the same directory.

Progress and failures also go to **stderr**, so run the binary from a terminal to watch them:

```bash
npm run build:no-bundle
./src-tauri/target/release/dsh-desktop
```

Rust, `config/runtime.json`, `ui/index.html` and `tauri.conf.json` changes only need `dev`
again — except `config/runtime.json`, which is compiled in and needs a rebuild. A new upstream
release means re-running the three setup scripts.

## Building for distribution

`npm run` is the shortest path; each script wraps `scripts/build.mjs` and resolves the Tauri CLI
through `npx`, so nothing needs installing first.

| Script                    | Builds                                      |
| ------------------------- | ------------------------------------------- |
| `npm run build`           | every configured target for the current OS  |
| `npm run build:deb`       | Debian package                              |
| `npm run build:rpm`       | RPM package                                 |
| `npm run build:linux`     | `deb` + `rpm`                               |
| `npm run build:windows`   | NSIS installer                              |
| `npm run build:macos`     | `.app` + `.dmg`                             |
| `npm run build:no-bundle` | the executable only                         |

Each target needs its own OS — the payload is platform-specific, so `build:windows` on Linux
will not produce a Windows installer. For anything not covered above, call the wrapper directly
and pass extra arguments through:

```bash
node scripts/build.mjs --bundles deb,rpm
```

Call the wrapper rather than the Tauri CLI directly: it resolves the CLI for you and gives CI
and the npm scripts one command surface.

Artifacts land in `src-tauri/target/release/bundle/`:

Every installer name carries the version, taken from `version` in `tauri.conf.json`.

| Target           | Path                                                          |
| ---------------- | ------------------------------------------------------------- |
| Executable       | `src-tauri/target/release/dsh-desktop` (`.exe` on Windows)     |
| Debian           | `bundle/deb/dsh-desktop_<version>_amd64.deb`                   |
| RPM              | `bundle/rpm/dsh-desktop-<version>-1.x86_64.rpm`                |
| NSIS             | `bundle/nsis/dsh-desktop_<version>_<arch>-setup.exe`           |
| macOS app        | `bundle/macos/dsh-desktop.app`                                 |
| macOS disk image | `bundle/dmg/dsh-desktop_<version>_<arch>.dmg`                  |

Measured on Linux x64: 76 MB `.deb`. The NSIS architecture token is `x64` or `arm64`, so do
not hardcode it.

### Releases

`.github/workflows/release.yml` runs daily and on demand. It resolves the version from the
npm dist-tag in `config/runtime.json` and compares it to the committed `.dsh-version`; if
unchanged it does nothing. Otherwise it builds on `ubuntu-22.04` (the glibc floor),
`ubuntu-24.04`, `windows-latest`, `macos-14` and `macos-13`, publishes `dsh-desktop-v<version>`
with the installers attached and release notes listing the commits since the previous tag, then
commits the new marker.

Builds must run on the target OS, because the payload contains platform-specific native addons
(`koffi`, `node-pty`, `sharp`) and a platform-specific Node binary. The app version mirrors the
upstream dsh version, so a build is traceable to the release it repackaged.

## Known limitations

- **Windows has never been built.** The Linux path is verified end to end; Windows depends on
  npm selecting the `win32-x64` prebuilds and on `Expand-Archive` for the Node zip. The first
  `windows-latest` run is its real check.
- **No code signing on any platform.** Unsigned Windows installers raise SmartScreen warnings,
  and Gatekeeper quarantines an unsigned macOS `.dmg`, so users must clear the attribute
  (`xattr -dr com.apple.quarantine`). Shipping to non-developers needs a Developer ID
  certificate plus notarisation.
- **No auto-update.** Users install new releases manually. Adding it back means Tauri's signed
  updater: a minisign keypair, `plugins.updater` config, `createUpdaterArtifacts`, and a
  published manifest. The signing key cannot be rotated, so lost means every installed copy is
  stranded.
- **AppImage is not built.** It needs FUSE via `linuxdeploy`, so Linux ships `deb` and `rpm`.
- **The title bar belongs to the compositor.** On Wayland it is drawn server-side, so its
  height follows the desktop theme and this app cannot restyle it. The window does advertise
  `resizable`, `maximizable`, `minimizable` and `closable` as true, so a dead button is a
  window-manager problem rather than a missing capability. Run with `DSH_DESKTOP_DIAG=1` to
  print those flags.
- **The harness page cannot be wrapped.** It must be the top-level document: a shell page on
  `tauri://localhost` cannot set the harness cookie on `http://127.0.0.1`, because WebKitGTK
  treats that as cross-site and refuses a `SameSite=Strict` cookie from either an iframe or a
  subresource request. That is why the shell navigates twice, and why a custom-title-bar shell
  page is not an option.
- **A brief `401` flashes on startup**, because of that second navigation. `cookieSettleMs` in
  `config/runtime.json` bounds how long it shows.
- **Force-killing the app orphans the runtime.** Closing the window stops the sidecar; `SIGKILL`
  leaves it running with its port and ~150 MB.
- **The single-instance lock can exit silently.** On Linux it is a D-Bus name, and a stale
  holder makes the next launch exit with no output. Check with
  `busctl --user list | grep SingleInstance`.
- **Icons are placeholders** — generic art, deliberately not DeepSeek's logo. Replace
  `src-tauri/icons/` before distributing.
- **`latest` points at a release candidate**, so this wrapper tracks rc releases. Change
  `npm.tag` in `config/runtime.json` to follow a different channel.
- **Upstream can break the wrapper.** The startup URL line and the auth handshake are internal
  contracts, not a stable API. The smoke test guards both; treat a failure there as "upstream
  changed", not "the wrapper broke".

## License

MIT, as declared in `src-tauri/Cargo.toml`. Upstream DeepSeek Harness is MIT too.

"DeepSeek" and the DeepSeek logo are DeepSeek's trademarks. This project is not affiliated
with or endorsed by DeepSeek; review upstream's
[`BRAND_GUIDELINES.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/BRAND_GUIDELINES.md)
before distributing anything carrying their branding.
