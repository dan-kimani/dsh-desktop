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

To pin an exact upstream release instead of following `npm.tag`, remember npm only forwards
arguments after `--`: `npm run setup -- --version 0.1.7-rc.1`. Without the separator npm
interprets `--version` itself, prints its own version and never runs the script.

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
release means re-running `npm run setup`, or building with `npm run build --latest`.

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

Add `--latest` on its own or after `--` — npm only forwards arguments that follow `--`, and
the wrapper reads `npm_config_latest` so the bare form works too:

```bash
npm run build --latest          # also accepted: npm run build -- --latest
```

Each target needs its own OS — the payload is platform-specific, so `build:windows` on Linux
will not produce a Windows installer. For anything not covered above, call the wrapper directly
and pass extra arguments through:

```bash
node scripts/build.mjs --bundles deb,rpm
```

Call the wrapper rather than the Tauri CLI directly: it resolves the CLI for you and gives CI
and the npm scripts one command surface.

**`build` bundles the payload already on disk — it does not check npm.** The bundler never
resolves the runtime itself, so after upstream publishes you must re-assemble first, or pass
`--latest` to do both in one step:

```bash
npm run build --latest           # re-assemble the published release, then bundle
```

`--latest` runs the same sequence as `npm run setup` and then stamps the version into
`tauri.conf.json` and `Cargo.toml`, so artifact names match the payload they contain. Without
it, a build after a new upstream release silently ships the previous runtime under the previous
version. `build:macos` accepts `--latest` too.

Because `--latest` records the version it built, it edits the tracked `.dsh-version` marker and
the generated `tauri.conf.json`/`Cargo.toml` versions. That is deliberate — CI commits the
marker the same way — but it leaves the tree dirty, so decide per build whether to keep or
revert it.

Artifacts land in `src-tauri/target/release/bundle/`:

Every installer name carries the version, taken from `version` in `tauri.conf.json`.

| Target           | Path                                                              |
| ---------------- | ----------------------------------------------------------------- |
| Executable       | `src-tauri/target/release/dsh-desktop` (`.exe` on Windows)         |
| Debian           | `bundle/deb/DeepSeek Harness_<version>_amd64.deb`                  |
| RPM              | `bundle/rpm/DeepSeek Harness-<version>-1.x86_64.rpm`               |
| NSIS             | `bundle/nsis/DeepSeek Harness_<version>_<arch>-setup.exe`          |
| macOS app        | `bundle/macos/DeepSeek Harness.app`                                |
| macOS disk image | `bundle/dmg/DeepSeek Harness_<version>_<arch>.dmg`                 |

Measured on Linux x64: 135 MB `.deb`. Most of that is upstream's LibreOffice WASM PDF engine.
The NSIS architecture token is `x64` or `arm64`, so do not hardcode it.

### Naming

**The app is `DeepSeek Harness` everywhere the operating system shows a name.** `productName`
in `tauri.conf.json` is the single source of truth: it titles the window, names the Debian and
RPM packages, the installers, the macOS `.app`, the GNOME/KDE desktop entry and the Windows
Start Menu shortcut and Apps-list entry. Nothing hardcodes it — the About dialog reads
`app.package_info().name` and the Linux entry templates it in as `Name={{name}}`.

The executable is the deliberate exception. `mainBinaryName` is `dsh-desktop`, so the packaged
binary, the sidecar lookup, `src-tauri/target/release/dsh-desktop`, and everything in `scripts/`
keep the name the project has always used. Only the labels change.

The renamed product name has a space in it. Two things follow:

- Linux installs resources to `/usr/lib/DeepSeek Harness` and writes
  `usr/share/applications/DeepSeek Harness.desktop`.
  `resource_dir()` resolves from `productName`, so the two agree; paths are passed to the Node
  sidecar as argv entries rather than through a shell, so nothing needs quoting.
- `bundle.linux.*.desktopTemplate` points at `src-tauri/linux/deepseek-harness.desktop`. It is a
  copy of Tauri's default entry whose only addition is the `Keywords` list, which keeps `dsh`
  and `dsh-desktop` findable in the launcher now that neither is the display name. `Exec`,
  `StartupWMClass` and `Icon` stay templated to the main binary.

**Upgrading from a `dsh-desktop` build is not automatic.** Tauri derives the Debian and RPM
package name by kebab-casing `productName`, which splits the camel case, so the package is now
`deep-seek-harness` (the installer files keep the name verbatim, spaces and all). Both packages
own `/usr/bin/dsh-desktop` and the `apps/dsh-desktop.png` icons, so remove the old one first:

```bash
sudo apt remove dsh-desktop
sudo apt install ./DeepSeek\ Harness_<version>_amd64.deb
```

### Releases

`.github/workflows/release.yml` runs daily and on demand. It resolves the version from the
npm dist-tag in `config/runtime.json` and compares it to the committed `.dsh-version`; if
unchanged it does nothing. Otherwise it builds on `ubuntu-22.04`, `windows-latest`, `macos-15`
and `macos-15-intel`, publishes `dsh-desktop-v<version>` with the installers attached and release notes
listing the commits since the previous tag, then commits the new marker.

Linux uses 22.04 only, for its lower glibc: a binary built there also runs on newer
distributions, which is not true in reverse. The payload's own native addons need at most
`GLIBC_2.28`, so building a second time on 24.04 would produce an artifact reachable by a
strict subset of users.

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
  `tauri://localhost` cannot hold the harness UI, because WebKitGTK treats the loopback origin
  as cross-site and will not send a `SameSite=Strict` cookie from an iframe or subresource
  request. A custom-title-bar shell page is therefore not an option.
- **The session cookie is installed host-side, not by the webview.** The wrapper redeems the
  launcher's `/?token=…` URL itself and injects the resulting cookie into the webview's jar
  before the single authenticated load, so no `401` body is ever rendered. The injected cookie
  is `SameSite=Lax` rather than the server's `Strict`: WebKitGTK will not send a `Strict` cookie
  on the first navigation out of the `tauri://localhost` loading page, while `Lax` is still sent
  on that top-level request and still blocks cross-site subresource sends. Letting the webview
  redeem the token itself does not work either: WebKitGTK does not replay the cookie on the
  `303`'s redirected request, the jar commits it too late for a fixed settle delay, and a
  navigation issued while that first load is still in flight never reaches the network at all —
  which is what left the app stuck on the `401` document.
- **Pasting an image needs a Linux-only bridge.** WebKitGTK never places clipboard images into a
  paste event's `DataTransfer` ([WebKit #168419](https://bugs.webkit.org/show_bug.cgi?id=168419)),
  so the harness UI's paste handler — which reads `event.clipboardData.items` — ignores a pasted
  screenshot. Chromium does expose them, which is why the same gesture works in `dsh web` and not
  here. `src-tauri/src/clipboard.rs` closes the gap: an injected shim asks the host for the
  clipboard image and re-dispatches a synthetic paste carrying a real `File` on the focused
  editor, because the harness editor listens on its contenteditable root rather than on
  `document`. Because the harness is a loopback *remote* origin, `capabilities/harness.json`
  grants `remote.urls` IPC access to `http://127.0.0.1:*`, and the command itself refuses any
  request whose webview is not on a loopback origin. macOS and Windows already deliver images
  through the paste event, so the bridge is Linux-only. The shim is only a string compiled into
  the binary, so `npm run test:clipboard` runs it against a stub DOM and asserts the two things
  that must be right for a paste to land: the IPC command name and the dispatch target.
- **Force-killing the app orphans the runtime.** Closing the window stops the sidecar; `SIGKILL`
  leaves it running with its port and ~150 MB.
- **The single-instance lock can exit silently.** On Linux it is a D-Bus name, and a stale
  holder makes the next launch exit with no output. Check with
  `busctl --user list | grep SingleInstance`.
- **Icons are placeholders** — generic art, deliberately not DeepSeek's logo. Replace
  `src-tauri/icons/` before distributing.
- **The tracked channel is `next`.** Upstream keeps prereleases off `latest` (still
  `0.1.5-rc.3`), and `alpha` has stalled at `0.1.7-alpha.2`, so `config/runtime.json` follows
  `next` (`0.1.7-rc.1`). Change `npm.tag` to move channels; `resolve-version.mjs` prints every
  dist-tag so a channel that stops moving is visible.
- **Upstream can break the wrapper.** The startup URL line and the auth handshake are internal
  contracts, not a stable API. The smoke test guards both; treat a failure there as "upstream
  changed", not "the wrapper broke".

## License

MIT, as declared in `src-tauri/Cargo.toml`. Upstream DeepSeek Harness is MIT too.

"DeepSeek" and the DeepSeek logo are DeepSeek's trademarks. This project is not affiliated
with or endorsed by DeepSeek; review upstream's
[`BRAND_GUIDELINES.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/BRAND_GUIDELINES.md)
before distributing anything carrying their branding.
