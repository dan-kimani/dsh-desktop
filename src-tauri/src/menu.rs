//! Native application menu: File, Edit, Help.
//!
//! Deliberately a real menu bar rather than HTML chrome. The window keeps native
//! decorations, so the compositor draws the title bar and its buttons keep
//! working; a custom in-window bar would mean a frameless window, and on Wayland
//! the compositor owns far more of that surface than Tauri exposes.

use tauri::menu::{
    AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{AppHandle, Manager};

use crate::harness;

/// Menu item ids handled in [`on_menu_event`].
pub const RELOAD: &str = "reload";
pub const OPEN_IN_BROWSER: &str = "open_in_browser";

/// Build and install the menu bar.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let reload = MenuItemBuilder::with_id(RELOAD, "Reload interface")
        .accelerator("CmdOrCtrl+R")
        .build(app)?;
    let open_browser = MenuItemBuilder::with_id(OPEN_IN_BROWSER, "Open in browser").build(app)?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit"))?;
    let close = MenuItemBuilder::with_id("close_window", "Close window")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&reload)
        .item(&open_browser)
        .separator()
        .item(&close)
        .item(&quit)
        .build()?;

    // Editing is predefined: copy/paste must reach the focused webview through
    // the platform's own handling rather than through the harness.
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    let docs = MenuItemBuilder::with_id("docs", "Documentation").build(app)?;
    let upstream =
        MenuItemBuilder::with_id("upstream", "DeepSeek Harness on GitHub").build(app)?;
    let about = PredefinedMenuItem::about(
        app,
        Some("About dsh-desktop"),
        Some(
            AboutMetadataBuilder::new()
                .name(Some("dsh-desktop"))
                .version(Some(env!("CARGO_PKG_VERSION")))
                .comments(Some(
                    "Desktop wrapper around the DeepSeek Harness web application. \
                     Not affiliated with or endorsed by DeepSeek.",
                ))
                .build(),
        ),
    )?;
    let help = SubmenuBuilder::new(app, "Help")
        .item(&docs)
        .item(&upstream)
        .separator()
        .item(&about)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&file, &edit, &help])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

/// Handle menu selections.
pub fn on_menu_event(app: &AppHandle, id: &str) {
    match id {
        RELOAD => {
            if let Err(detail) = harness::reload(app) {
                eprintln!("dsh-desktop: reload failed: {detail}");
            }
        }
        OPEN_IN_BROWSER => {
            if let Err(detail) = harness::open_in_browser(app) {
                eprintln!("dsh-desktop: could not open the browser: {detail}");
            }
        }
        "close_window" => {
            if let Some(window) = app.get_webview_window(harness::WINDOW_LABEL) {
                let _ = window.close();
            }
        }
        "docs" => open(
            app,
            "https://github.com/deepseek-ai/deepseek-harness#readme",
        ),
        "upstream" => open(app, "https://github.com/deepseek-ai/deepseek-harness"),
        _ => {}
    }
}

/// Open a web link in the user's browser, through the opener plugin.
fn open(app: &AppHandle, url: &str) {
    use tauri_plugin_opener::OpenerExt;
    if let Err(detail) = app.opener().open_url(url, None::<String>) {
        eprintln!("dsh-desktop: could not open {url}: {detail}");
    }
}
