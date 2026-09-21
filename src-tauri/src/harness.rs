//! Wrapper around the bundled DeepSeek Harness runtime.
//!
//! Responsibilities, and nothing else:
//!   1. locate the bundled runtime inside the installed resource directory
//!   2. bootstrap the wrapper's own profile on first launch
//!   3. spawn the Node sidecar and parse the `dsh web: <url>` stdout contract
//!   4. navigate the webview to the authenticated URL
//!   5. guarantee the child dies with the app
//!
//! The launch shape (profile name, port, flags, stdout pattern) comes from
//! `config/runtime.json`, baked in at compile time, so it has exactly one
//! definition shared with the packaging scripts.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// The shared runtime configuration, compiled in from the repo's config file.
#[derive(Debug, Deserialize)]
pub struct RuntimeConfig {
    pub profile: ProfileConfig,
    pub launch: LaunchConfig,
    pub stdout: StdoutConfig,
}

#[derive(Debug, Deserialize)]
pub struct ProfileConfig {
    pub name: String,
    #[serde(rename = "sourceTemplate")]
    pub source_template: String,
}

#[derive(Debug, Deserialize)]
pub struct LaunchConfig {
    pub host: String,
    pub port: u16,
    #[serde(rename = "noOpen")]
    pub no_open: bool,
    #[serde(rename = "extraArgs", default)]
    pub extra_args: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct StdoutConfig {
    #[serde(rename = "urlPattern")]
    pub url_pattern: String,
    #[serde(rename = "readyTimeoutMs")]
    pub ready_timeout_ms: u64,
    /// Grace period for the webview to store the session cookie, which is also how
    /// long the intermediate `401` document could be on screen.
    #[serde(rename = "cookieSettleMs")]
    pub cookie_settle_ms: u64,
}

/// Parsed from `config/runtime.json` at compile time.
pub fn runtime_config() -> &'static RuntimeConfig {
    static CONFIG: std::sync::OnceLock<RuntimeConfig> = std::sync::OnceLock::new();
    CONFIG.get_or_init(|| {
        serde_json::from_str(include_str!("../../config/runtime.json"))
            .expect("config/runtime.json must be valid JSON with the expected keys")
    })
}

/// Label of the application window and its single webview, as declared in
/// `tauri.conf.json`.
pub const WINDOW_LABEL: &str = "main";

/// Target triple of the Node sidecar staged for this build, mirroring the
/// `hostTriple` table in `scripts/fetch-runtime.mjs`.
const TARGET_TRIPLE: &str = if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
    "x86_64-unknown-linux-gnu"
} else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
    "aarch64-unknown-linux-gnu"
} else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
    "x86_64-pc-windows-msvc"
} else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
    "aarch64-pc-windows-msvc"
} else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
    "aarch64-apple-darwin"
} else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
    "x86_64-apple-darwin"
} else {
    "unknown"
};

/// Version pin and target of the bundled runtime, shown on the loading page.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RuntimeInfo {
    pub dsh_version: String,
    pub target: String,
}

/// Read the dsh version pinned by the bundled runtime manifest.
///
/// Pure over the file text so it can be unit-tested; IO lives with the caller.
fn bundled_dsh_version(manifest: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(manifest)
        .ok()?
        .get("dependencies")?
        .get("@deepseek-ai/dsh")?
        .as_str()
        .map(str::to_string)
}

/// Describe the bundled runtime, falling back to `unknown` when the staged
/// tree cannot be read (e.g. an incomplete setup) rather than failing startup
/// over a cosmetic label.
fn runtime_info(app: &AppHandle) -> RuntimeInfo {
    let dsh_version = app
        .path()
        .resource_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("runtime").join("package.json")).ok())
        .and_then(|text| bundled_dsh_version(&text))
        .unwrap_or_else(|| "unknown".to_string());
    RuntimeInfo {
        dsh_version,
        target: TARGET_TRIPLE.to_string(),
    }
}

/// The harness origin currently loaded, so the File menu can reload it.
#[derive(Default)]
pub struct HarnessOrigin(pub Mutex<Option<String>>);

/// Holds the live sidecar so it can be killed on shutdown.
pub struct SidecarState(pub Mutex<Option<CommandChild>>);

/// Fatal startup failure, reported to the loading page instead of a blank window.
#[derive(Debug, Clone, serde::Serialize)]
pub struct StartupFailure {
    pub message: String,
    pub detail: String,
}

/// Locate `runtime/node_modules/@deepseek-ai/dsh/lib/bin.js` in the installed app.
fn locate_dsh_entry(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("could not resolve the resource directory: {e}"))?;
    let entry = resource_dir
        .join("runtime")
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js");

    if !entry.is_file() {
        return Err(format!(
            "bundled dsh entry point is missing at {}.\n\
             The runtime payload was not packaged correctly; rebuild with \
             `node scripts/fetch-runtime.mjs` before bundling.",
            entry.display()
        ));
    }
    Ok(entry)
}

/// The harness home, shared with the CLI so sessions and credentials carry over.
///
/// This deliberately matches the CLI's own resolution (`$DSH_HOME`, else
/// `~/.dsh`). Sessions live under `$DSH_HOME/sessions/<project key>/`, keyed by
/// the session's working directory, and a session record carries no profile
/// field — so pointing both apps at one home is what lets the CLI read desktop
/// sessions and vice versa. Credentials and settings live there too, so signing
/// in once covers both.
///
/// What is deliberately *not* shared is the profile: this wrapper still boots
/// `profiles/tauri`, while the CLI uses `profiles/web` and the official Electron
/// app owns `profiles/desktop`. Sharing a profile directory is what would let two
/// processes race on one `node_modules`.
pub(crate) fn harness_home() -> Result<PathBuf, String> {
    if let Some(explicit) = std::env::var_os("DSH_DESKTOP_HOME") {
        return Ok(PathBuf::from(explicit));
    }
    // Honour an existing $DSH_HOME, so a relocated harness stays relocated.
    if let Some(explicit) = std::env::var_os("DSH_HOME") {
        if !explicit.is_empty() {
            return Ok(PathBuf::from(explicit));
        }
    }
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|home| PathBuf::from(home).join(".dsh"))
        .ok_or_else(|| {
            "could not determine the home directory; set DSH_DESKTOP_HOME or DSH_HOME".to_string()
        })
}

/// The working directory agent sessions start in.
fn workspace_dir() -> PathBuf {
    if let Some(explicit) = std::env::var_os("DSH_DESKTOP_CWD") {
        return PathBuf::from(explicit);
    }
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Run a short-lived dsh command to completion with the wrapper's environment.
async fn run_to_completion(
    app: &AppHandle,
    entry: &Path,
    home: &Path,
    args: Vec<String>,
    label: &str,
) -> Result<(), String> {
    let sidecar = app
        .shell()
        .sidecar("node")
        .map_err(|e| format!("could not resolve the bundled Node sidecar: {e}"))?
        .args([entry.to_string_lossy().to_string()])
        .args(args)
        .env("DSH_HOME", home.to_string_lossy().to_string())
        .current_dir(home);

    let (mut rx, _child) = sidecar
        .spawn()
        .map_err(|e| format!("could not spawn the runtime for {label}: {e}"))?;

    let mut stderr = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(line) => stderr.push_str(&String::from_utf8_lossy(&line)),
            CommandEvent::Terminated(payload) => {
                if payload.code != Some(0) {
                    return Err(format!(
                        "{label} failed with exit code {:?}\n{}",
                        payload.code,
                        stderr.trim()
                    ));
                }
                return Ok(());
            }
            _ => {}
        }
    }
    Ok(())
}

/// Bootstrap the wrapper's profile from the shipped template, once.
async fn ensure_profile(app: &AppHandle, entry: &Path, home: &Path) -> Result<(), String> {
    let config = runtime_config();
    let profile_dir = home.join("profiles").join(&config.profile.name);
    if profile_dir.join("cordis.yml").is_file() {
        return Ok(());
    }

    std::fs::create_dir_all(home).map_err(|e| {
        format!(
            "could not create the harness home at {}: {e}",
            home.display()
        )
    })?;

    emit_log(
        app,
        &format!("initializing profile \"{}\"", config.profile.name),
    );
    // `--dump-config` makes this a create-then-exit operation rather than a boot.
    run_to_completion(
        app,
        entry,
        home,
        vec![
            "--profile".into(),
            config.profile.name.clone(),
            "--from-default-profile".into(),
            config.profile.source_template.clone(),
            "--dump-config".into(),
        ],
        "profile bootstrap",
    )
    .await
}

/// Emit a line of progress to the loading page.
fn emit_log(app: &AppHandle, message: &str) {
    let _ = app.emit("dsh-log", message.to_string());
}

/// Report a fatal startup failure to the loading page and stop.
///
/// Deliberately writes to stderr *as well as* emitting to the webview. The
/// loading page is what the user sees, but it is only mounted until navigation
/// begins — a failure after that would otherwise be completely silent, which is
/// how a blank or 401 window ends up unexplained in the field.
fn report_failure(app: &AppHandle, message: impl Into<String>, detail: impl Into<String>) {
    let message = message.into();
    let detail = detail.into();
    eprintln!("dsh-desktop: FAILURE: {message}");
    for line in detail.lines() {
        eprintln!("dsh-desktop:   {line}");
    }
    let _ = app.emit("dsh-failed", StartupFailure { message, detail });
}

/// Compile the stdout pattern from the shared config.
fn url_regex() -> &'static regex_lite::Regex {
    static RE: std::sync::OnceLock<regex_lite::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex_lite::Regex::new(&runtime_config().stdout.url_pattern)
            .expect("config/runtime.json stdout.urlPattern must be a valid regex")
    })
}

/// Load the authenticated UI, working around a WebKitGTK cookie-timing quirk.
///
/// The launcher's URL carries a one-time token that the server trades for an
/// `HttpOnly` session cookie bound to the request authority, answering `303`.
/// WebKitGTK **stores** that cookie when it follows the redirect itself, but does
/// not **replay** it on the redirected request — so the document that renders is
/// the raw `401` body. Resolving the token outside the webview does not help
/// either: a Rust-side HTTP client has no access to WebKit's cookie store, so
/// nothing is ever stored.
///
/// So the webview performs the exchange, and then loads the UI. Verified against
/// the running server:
///
/// | request             | response       |
/// |---------------------|----------------|
/// | `/?token=…`         | `303` + cookie |
/// | `/` with the cookie | `200` + the UI |
///
/// The caller drains the runtime's stdout while the settle delay elapses, then
/// calls [`navigate_clean`]. The exchange must be a navigation: a `no-cors`
/// subresource request from the loading page does NOT store the cookie, because
/// WebKitGTK refuses a `SameSite=Strict` cookie set by a cross-site request
/// (verified: the jar stays empty and the UI loads unauthenticated).
///
/// @param app - application handle
/// @param tokenized - the tokenized URL printed by the launcher
/// @returns the clean origin to navigate to once the cookie has landed
fn begin_session(app: &AppHandle, tokenized: &str) -> Result<String, String> {
    let parsed: url::Url = tokenized
        .parse()
        .map_err(|e| format!("could not parse {tokenized}: {e}"))?;
    let webview = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| "the application window is missing".to_string())?;

    // Navigating is what stores the cookie; the redirect target is a 401 until the
    // second navigation, which is why the loading page is held on screen for
    // `cookieSettleMs` and the authenticated load follows.
    webview
        .navigate(parsed.clone())
        .map_err(|e| format!("the first navigation failed: {e}"))?;
    Ok(parsed.origin().ascii_serialization())
}

/// Second load: now authenticated, and the URL the webview keeps.
fn navigate_clean(app: &AppHandle, origin: &str) -> Result<(), String> {
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| "the application window is missing".to_string())?;
    let webview = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| "the harness webview is missing".to_string())?;
    let clean = origin
        .parse()
        .map_err(|e| format!("the runtime reported an origin this app could not parse: {e}"))?;
    webview
        .navigate(clean)
        .map_err(|e| format!("the authenticated navigation failed: {e}"))?;
    // Record it so File → Reload can re-navigate after the exchange is done.
    remember_origin(app, origin);
    let _ = window.show();
    let _ = window.set_focus();

    // Diagnostic: report what the window manager believes about this window. A
    // compositor disables (or ignores) its own minimize/maximize controls when the
    // window does not advertise the capability, so these flags explain a title bar
    // whose buttons do nothing. Enabled with DSH_DESKTOP_DIAG=1.
    if std::env::var_os("DSH_DESKTOP_DIAG").is_some() {
        eprintln!(
            "dsh-desktop: DIAG window resizable={:?} maximizable={:?} minimizable={:?} \
             closable={:?} decorated={:?} maximized={:?} visible={:?}",
            window.is_resizable(),
            window.is_maximizable(),
            window.is_minimizable(),
            window.is_closable(),
            window.is_decorated(),
            window.is_maximized(),
            window.is_visible(),
        );
    }
    Ok(())
}

/// Start the harness and point the main window at its authenticated URL.
///
/// Every failure path reports to the loading page: a silent failure here would
/// look identical to "still starting", which is the worst possible UX.
pub async fn start(app: AppHandle) {
    let config = runtime_config();

    // Reveal the window straight away. The runtime spends several seconds composing
    // its plugin tree before it prints a URL, and the window used to stay hidden for
    // all of it, so launching looked like nothing was happening. The loading page is
    // already on screen here and reports progress as it arrives.
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
    }

    // Label the loading page with what is actually bundled, while it is still
    // mounted. Emitted even when the runtime turns out to be incomplete.
    let _ = app.emit("dsh-runtime", runtime_info(&app));

    let entry = match locate_dsh_entry(&app) {
        Ok(entry) => entry,
        Err(message) => return report_failure(&app, "The bundled runtime is incomplete.", message),
    };
    let home = match harness_home() {
        Ok(home) => home,
        Err(message) => {
            return report_failure(&app, "Could not determine the harness home.", message)
        }
    };

    if let Err(detail) = ensure_profile(&app, &entry, &home).await {
        return report_failure(
            &app,
            "Could not initialize the DeepSeek Harness profile.",
            detail,
        );
    }

    emit_log(&app, "starting the harness runtime");
    // Launcher flags must precede the inner arguments; the launcher hands the
    // first token it does not recognize to the booted app.
    let mut args = vec!["--profile".to_string(), config.profile.name.clone()];
    args.push("--host".to_string());
    args.push(config.launch.host.clone());
    if config.launch.no_open {
        args.push("--no-open".to_string());
    }
    args.push("--port".to_string());
    args.push(config.launch.port.to_string());
    args.extend(config.launch.extra_args.iter().cloned());

    let sidecar = match app
        .shell()
        .sidecar("node")
        .map_err(|e| format!("could not resolve the bundled Node sidecar: {e}"))
        .and_then(|command| {
            command
                .args([entry.to_string_lossy().to_string()])
                .args(args)
                .env("DSH_HOME", home.to_string_lossy().to_string())
                .current_dir(workspace_dir())
                .spawn()
                .map_err(|e| format!("could not spawn the runtime: {e}"))
        }) {
        Ok(pair) => pair,
        Err(detail) => {
            return report_failure(
                &app,
                "Could not start the DeepSeek Harness runtime.",
                detail,
            )
        }
    };

    let (mut rx, child) = sidecar;
    if let Some(state) = app.try_state::<SidecarState>() {
        *state.0.lock().unwrap() = Some(child);
    }

    // A runtime that neither announces a URL nor exits would otherwise leave the
    // loading window spinning forever with no explanation. `readyTimeoutMs` from
    // the shared config bounds that wait and turns it into a visible error.
    // Racing the timer against the event stream (rather than a detached timer
    // task) means the deadline applies once, to this loop, and needs no shared
    // latching between tasks.
    let deadline = tokio::time::sleep(Duration::from_millis(config.stdout.ready_timeout_ms));
    tokio::pin!(deadline);
    let mut timed_out = false;

    let url_pattern = url_regex();
    let mut stdout_buffer = String::new();
    let mut stderr_tail = String::new();
    let mut navigated = false;
    let mut exited = false;
    // Set once the token URL has been handed to the loading page; the origin is
    // needed for the authenticated navigation, `exchange_timer` paces it.
    let mut clean_origin: Option<String> = None;
    // Fires for the authenticated load, once the cookie has had time to land.
    let mut exchange_timer: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;

    loop {
        let event = tokio::select! {
            event = rx.recv() => event,
            // The deadline only matters until the UI is up; once navigated, the
            // stream must keep being drained for the app's whole lifetime.
            () = &mut deadline, if !navigated => {
                timed_out = true;
                report_failure(
                    &app,
                    "DeepSeek Harness did not become ready in time.",
                    format!(
                        "waited {}s for a line matching {:?}.\n\
                         If this persists, run the app from a terminal to see runtime output.",
                        config.stdout.ready_timeout_ms / 1000,
                        config.stdout.url_pattern
                    ),
                );
                shutdown(&app);
                None
            }
            // Phase two: the cookie has had its moment, so load the UI.
            () = async {
                match exchange_timer.as_mut() {
                    Some(deadline) => deadline.as_mut().await,
                    // Never resolve while there is no second phase pending.
                    None => std::future::pending().await,
                }
            }, if clean_origin.is_some() => {
                exchange_timer = None;
                let origin = clean_origin.take().expect("guarded by is_some");
                navigated = true;
                match navigate_clean(&app, &origin) {
                    Ok(()) => eprintln!("dsh-desktop: UI loaded from {origin}"),
                    Err(detail) => report_failure(
                        &app,
                        "Could not open the DeepSeek Harness interface.",
                        detail,
                    ),
                }
                continue;
            }
        };
        let Some(event) = event else { break };
        match event {
            CommandEvent::Stdout(line) => {
                let text = String::from_utf8_lossy(&line).to_string();
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    println!("[dsh] {trimmed}");
                    emit_log(&app, trimmed);
                }
                if navigated {
                    continue;
                }
                stdout_buffer.push_str(&text);
                stdout_buffer.push('\n');

                // The launcher prints its URL once readiness is committed, so a
                // match here is a genuine readiness signal, not a heuristic.
                if let Some(captures) = url_pattern.captures(&stdout_buffer) {
                    if let Some(url) = captures.get(1) {
                        let url = url.as_str().to_string();
                        eprintln!("dsh-desktop: loading the authenticated UI from {url}");
                        emit_log(&app, "loading the harness interface");
                        // Phase one: hand the token URL to the loading page, which
                        // requests it so WebKitGTK stores the session cookie.
                        match begin_session(&app, &url) {
                            Ok(origin) => {
                                exchange_timer = Some(Box::pin(tokio::time::sleep(
                                    Duration::from_millis(config.stdout.cookie_settle_ms),
                                )));
                                clean_origin = Some(origin);
                            }
                            Err(detail) => {
                                navigated = true;
                                report_failure(
                                    &app,
                                    "Could not open the DeepSeek Harness interface.",
                                    detail,
                                );
                            }
                        }
                    }
                }
            }
            CommandEvent::Stderr(line) => {
                let text = String::from_utf8_lossy(&line).to_string();
                eprintln!("[dsh] {}", text.trim_end());
                // Keep a tail for the failure report; the boot error is usually last.
                stderr_tail.push_str(&text);
                if stderr_tail.len() > 8192 {
                    let cut = stderr_tail.len() - 8192;
                    stderr_tail = stderr_tail[cut..].to_string();
                }
                emit_log(&app, text.trim_end());
            }
            CommandEvent::Terminated(payload) => {
                exited = true;
                if let Some(state) = app.try_state::<SidecarState>() {
                    *state.0.lock().unwrap() = None;
                }
                if !navigated {
                    report_failure(
                        &app,
                        "The DeepSeek Harness runtime stopped before it became ready.",
                        format!("exit code {:?}\n{}", payload.code, stderr_tail.trim()),
                    );
                }
                break;
            }
            _ => {}
        }
    }

    // `timed_out` already produced a more specific message.
    if !navigated && !exited && !timed_out {
        report_failure(
            &app,
            "The runtime never reported a ready URL.",
            format!(
                "the process ended without matching {:?}",
                config.stdout.url_pattern
            ),
        );
    }
}

/// Stop the sidecar. Called from the window `Destroyed`/exit handler.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<SidecarState>() {
        if let Some(child) = state.0.lock().unwrap().take() {
            let _ = child.kill();
        }
    }
}

/// Remember the authenticated origin so the UI can be reloaded later.
fn remember_origin(app: &AppHandle, origin: &str) {
    if let Some(state) = app.try_state::<HarnessOrigin>() {
        *state.0.lock().unwrap() = Some(origin.to_string());
    }
}

/// The origin the harness is currently served from, once it is known.
fn current_origin(app: &AppHandle) -> Result<String, String> {
    app.try_state::<HarnessOrigin>()
        .and_then(|state| state.0.lock().unwrap().clone())
        .ok_or_else(|| "the harness has not finished starting".to_string())
}

/// File -> Reload interface. Re-navigates to the origin the webview is already
/// authenticated against, so no new token exchange is needed.
pub fn reload(app: &AppHandle) -> Result<(), String> {
    let origin = current_origin(app)?;
    let url = origin
        .parse()
        .map_err(|e| format!("stored origin {origin} is not a valid URL: {e}"))?;
    app.get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| "the application window is missing".to_string())?
        .navigate(url)
        .map_err(|e| format!("reload failed: {e}"))
}

/// File -> Open in browser.
pub fn open_in_browser(app: &AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let origin = current_origin(app)?;
    app.opener()
        .open_url(origin, None::<String>)
        .map_err(|e| format!("could not open the browser: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pinned_dsh_version() {
        let manifest = r#"{"name":"dsh-desktop-runtime","private":true,"version":"0.0.0","dependencies":{"@deepseek-ai/dsh":"0.1.5-rc.2"}}"#;
        assert_eq!(bundled_dsh_version(manifest).as_deref(), Some("0.1.5-rc.2"));
    }

    #[test]
    fn rejects_manifest_without_pin() {
        assert_eq!(bundled_dsh_version(r#"{"dependencies":{}}"#), None);
        assert_eq!(bundled_dsh_version("not json"), None);
        assert_eq!(
            bundled_dsh_version(r#"{"dependencies":{"@deepseek-ai/dsh":42}}"#),
            None
        );
    }
}
