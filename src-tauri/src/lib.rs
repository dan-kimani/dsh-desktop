//! Tauri application entry point for the dsh-desktop wrapper.
//!
//! Lifecycle: install the menu, show a loading webview, start the bundled
//! harness, navigate to the URL it announces, and guarantee the sidecar dies
//! with the app.

mod clipboard;
mod harness;
mod menu;
mod window_state;

use tauri::{Manager, WebviewWindowBuilder, WindowEvent};

use harness::SidecarState;

/// Build and run the desktop shell.
pub fn run() {
    tauri::Builder::default()
        // Only one instance may own the harness profile: a second process would
        // race the first on the same `profiles/<name>/node_modules`.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window(harness::WINDOW_LABEL) {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(SidecarState(Default::default()))
        .manage(harness::HarnessOrigin::default())
        .setup(|app| {
            // Created here rather than by Tauri's own config pass so the
            // clipboard-image shim lands before any harness script runs. The
            // window options stay in `tauri.conf.json`; only `create` is off.
            // `SHIM_JS` is empty off Linux, where paste already carries images.
            if let Some(config) = app.config().app.windows.first().cloned() {
                WebviewWindowBuilder::from_config(app.handle(), &config)?
                    .initialization_script(clipboard::SHIM_JS)
                    .build()?;
            }

            if let Err(error) = menu::install(app.handle()) {
                // A missing menu must not stop the app from starting.
                eprintln!("dsh-desktop: could not install the menu: {error}");
            }

            // Place the window where the user left it before the runtime task
            // shows it; a missing or unusable state keeps the config defaults.
            window_state::restore(app.handle());

            let handle = app.handle().clone();
            // Spawn outside setup so a slow boot never blocks window creation.
            tauri::async_runtime::spawn(async move {
                harness::start(handle).await;
            });
            Ok(())
        })
        .on_menu_event(|app, event| menu::on_menu_event(app, event.id().as_ref()))
        .on_window_event(|window, event| match event {
            WindowEvent::Destroyed => harness::shutdown(window.app_handle()),
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                window_state::remember(window.app_handle());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![clipboard::read_clipboard_image])
        .build(tauri::generate_context!())
        .expect("failed to build the dsh-desktop application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                harness::shutdown(app);
            }
        });
}
