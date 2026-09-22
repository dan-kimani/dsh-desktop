fn main() {
    // Declaring the app's own commands is what lets `tauri-build` autogenerate
    // `allow-*`/`deny-*` permissions for them, which a capability can then name.
    // Plugin commands are declared by their plugins; only ours appear here.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["read_clipboard_image"]),
        ),
    )
    .expect("failed to run tauri-build");
}
