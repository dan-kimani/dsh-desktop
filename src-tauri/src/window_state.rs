//! Persist the main window's geometry across restarts.
//!
//! The state file lives inside the harness home, so a `DSH_DESKTOP_HOME` test
//! run gets default geometry instead of inheriting the real one. Only the
//! last known normal bounds plus a maximized flag are recorded; while
//! maximized or fullscreen the stored bounds are left untouched so restoring
//! still yields the useful rectangle.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Monitor, PhysicalPosition, PhysicalSize};

use crate::harness;

/// Wrapper-owned state file inside the harness home.
const STATE_FILE: &str = "dsh-desktop-window.json";

/// Minimum sane window, mirroring `tauri.conf.json` (`minWidth`/`minHeight`).
const MIN_WIDTH: u32 = 720;
const MIN_HEIGHT: u32 = 480;

/// Last known geometry of the main window, in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

/// Reject corrupt states (e.g. a truncated write). Pure so it can be
/// unit-tested; placement against real monitors happens at apply time.
fn sanitize(state: WindowState) -> Option<WindowState> {
    if state.width < MIN_WIDTH || state.height < MIN_HEIGHT {
        return None;
    }
    Some(state)
}

fn state_path(home: &Path) -> PathBuf {
    home.join(STATE_FILE)
}

fn load(home: &Path) -> Option<WindowState> {
    let text = std::fs::read_to_string(state_path(home)).ok()?;
    sanitize(serde_json::from_str(&text).ok()?)
}

/// True when any part of the saved rectangle is on a connected monitor.
/// Guards against restoring onto a display that has since been unplugged; when
/// the monitors cannot be listed at all, the file is trusted.
fn on_any_monitor(window: &tauri::WebviewWindow, state: &WindowState) -> bool {
    let monitors = match window.available_monitors() {
        Ok(monitors) => monitors,
        Err(_) => return true,
    };
    monitors.iter().any(|monitor| overlaps(monitor, state))
}

fn overlaps(monitor: &Monitor, state: &WindowState) -> bool {
    let (x, y) = (monitor.position().x, monitor.position().y);
    let (w, h) = (monitor.size().width as i32, monitor.size().height as i32);
    state.x < x + w
        && state.x + state.width as i32 > x
        && state.y < y + h
        && state.y + state.height as i32 > y
}

/// Apply the saved geometry, if there is usable state. Runs in `setup`, before
/// the runtime task shows the window, so the first paint is already placed.
pub fn restore(app: &AppHandle) {
    let Some(window) = app.get_webview_window(harness::WINDOW_LABEL) else {
        return;
    };
    let Ok(home) = harness::harness_home() else {
        return;
    };
    let Some(state) = load(&home) else {
        return;
    };
    if !on_any_monitor(&window, &state) {
        return;
    }
    let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
    let _ = window.set_size(PhysicalSize::new(state.width, state.height));
    if state.maximized {
        let _ = window.maximize();
    }
}

/// Record the main window's geometry. Called on move/resize; while maximized
/// or fullscreen only the flag is updated so the stored bounds stay useful.
pub fn remember(app: &AppHandle) {
    let Some(window) = app.get_webview_window(harness::WINDOW_LABEL) else {
        return;
    };
    if window.is_fullscreen().unwrap_or(false) {
        return;
    }
    let Ok(home) = harness::harness_home() else {
        return;
    };
    let maximized = window.is_maximized().unwrap_or(false);
    let mut state = load(&home).unwrap_or(WindowState {
        x: 0,
        y: 0,
        width: MIN_WIDTH,
        height: MIN_HEIGHT,
        maximized: false,
    });
    state.maximized = maximized;
    if !maximized {
        if let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) {
            state.x = position.x;
            state.y = position.y;
            state.width = size.width;
            state.height = size.height;
        }
    }
    let _ = std::fs::write(
        state_path(&home),
        serde_json::to_string(&state).unwrap_or_default(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_normal_geometry() {
        let state = WindowState {
            x: 100,
            y: 100,
            width: 1280,
            height: 800,
            maximized: false,
        };
        assert_eq!(sanitize(state), Some(state));
    }

    #[test]
    fn rejects_below_minimum_size() {
        let base = WindowState {
            x: 0,
            y: 0,
            width: 1280,
            height: 800,
            maximized: false,
        };
        assert_eq!(sanitize(WindowState { width: 100, ..base }), None);
        assert_eq!(
            sanitize(WindowState {
                height: 100,
                ..base
            }),
            None
        );
    }

    #[test]
    fn keeps_maximized_flag() {
        let state = WindowState {
            x: 0,
            y: 0,
            width: 1280,
            height: 800,
            maximized: true,
        };
        assert_eq!(sanitize(state).unwrap().maximized, true);
    }
}
