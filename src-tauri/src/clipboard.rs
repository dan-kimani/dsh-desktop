//! Native clipboard-image bridge.
//!
//! WebKitGTK never places clipboard images into a paste event's `DataTransfer`
//! (WebKit #168419), so the harness UI's paste handler — which only inspects
//! `event.clipboardData.items` — silently ignores a pasted screenshot on Linux.
//! Chromium (the `dsh web` surface) does expose them, which is why the same
//! gesture works in a browser and not in this webview.
//!
//! [`SHIM_JS`] covers the gap without touching upstream UI code: it sees a
//! paste that carried no file, asks the host for the clipboard image, and
//! re-dispatches a synthetic paste event carrying a real `File`. Upstream's
//! handler then runs on its normal path.
//!
//! The bridge is deliberately Linux-only — macOS and Windows already deliver
//! images through the paste event, so shipping the shim there would mean
//! invoking a command that is not compiled in. On those targets [`SHIM_JS`] is
//! empty and [`read_clipboard_image`] does not exist.
//!
//! [`read_clipboard_image`] refuses to answer unless the requesting webview is
//! on a loopback origin — the capability that exposes it is reachable from the
//! remote harness page, so the command must not become a general clipboard
//! oracle for anything else the webview might navigate to.

#[cfg(target_os = "linux")]
use tauri::Webview;

/// Largest clipboard image accepted, in pixels. `arboard` has already
/// materialised the bitmap by this point, so this bounds our own encode work
/// rather than the allocation that provoked it.
#[cfg(target_os = "linux")]
const MAX_IMAGE_PIXELS: u64 = 50_000_000;

/// JavaScript injected into the harness page before its own scripts run.
#[cfg(target_os = "linux")]
pub const SHIM_JS: &str = r#"(function () {
  if (window.__dshClipboardImageBridge) return;
  window.__dshClipboardImageBridge = true;

  var failuresLogged = 0;

  function fileFromDataUrl(dataUrl, name) {
    var comma = dataUrl.indexOf(",");
    if (comma < 0) return Promise.resolve(null);
    var meta = dataUrl.slice(5, dataUrl.indexOf(";"));
    var binary = atob(dataUrl.slice(comma + 1));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return Promise.resolve(new File([bytes], name, { type: meta || "image/png" }));
  }

  // The harness reads pasted images from `event.clipboardData.items` only.
  // Text pastes and real file pastes already work, so act solely on the case
  // this platform drops: no file items, and no text to fall back to.
  function onPaste(event) {
    var data = event.clipboardData;
    if (!data) return;
    for (var i = 0; i < data.items.length; i += 1) {
      if (data.items[i].kind === "file") return;
    }
    if (data.getData("text/plain") !== "") return;

    // Capture phase plus this call keeps the (empty) paste from reaching the
    // editor, which would otherwise clear the draft.
    event.preventDefault();
    event.stopImmediatePropagation();

    invoke("read-clipboard-image")
      .then(function (dataUrl) {
        if (typeof dataUrl !== "string" || dataUrl === "") return null;
        return fileFromDataUrl(dataUrl, "pasted-image.png");
      })
      .then(function (file) {
        if (file === null) return;
        var transfer = new DataTransfer();
        transfer.items.add(file);
        document.dispatchEvent(new ClipboardEvent("paste", {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true
        }));
      })
      .catch(function (error) {
        // Losing a paste is worth one console line, not a broken input bar.
        if (failuresLogged < 3) {
          failuresLogged += 1;
          console.warn("dsh-desktop: clipboard image paste failed:", error);
        }
      });
  }

  var attempts = 0;

  // Wry installs our script and Tauri's IPC bootstrap as separate user scripts,
  // so `invoke` may not exist yet on the first tick. Poll briefly rather than
  // giving up permanently; a failure here would silently restore the bug.
  function install() {
    var bridge = window.__TAURI_INTERNALS__;
    if (!bridge || typeof bridge.invoke !== "function") {
      attempts += 1;
      if (attempts < 40) setTimeout(install, 50);
      return;
    }
    invoke = function (command) { return bridge.invoke(command); };
    document.addEventListener("paste", onPaste, true);
  }

  install();
})();"#;

/// No bridge is needed away from Linux, and none may be shipped: the command it
/// calls is not compiled in, so an installed shim could only fail.
#[cfg(not(target_os = "linux"))]
pub const SHIM_JS: &str = "";

/// Whether `url` is an origin this wrapper serves the UI from.
///
/// The harness binds `127.0.0.1` on an OS-assigned port, so the check is on the
/// host, not the port. `localhost` is accepted because a resolver may normalise
/// it, and an IPv6 loopback for the same reason.
fn is_loopback(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        Some(url::Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

/// Read an image from the system clipboard, encoded as a PNG data URL.
///
/// Returns `Ok(None)` when the clipboard holds no image, which the shim treats
/// as "nothing to paste" rather than an error. The ACL identifier for this
/// command is `allow-read-clipboard-image`: `tauri-build` slugifies the
/// snake_case name, and the shim invokes that same slug.
///
/// The command is registered and ACL-gated on every target so the handler table
/// is uniform; off Linux it answers `Ok(None)` and [`SHIM_JS`] is empty, so
/// nothing ever calls it — only WebKitGTK drops clipboard images.
#[tauri::command]
pub async fn read_clipboard_image(webview: Webview) -> Result<Option<String>, String> {
    let origin = webview
        .url()
        .map_err(|error| format!("could not read the requesting URL: {error}"))?;
    if !is_loopback(&origin) {
        return Err("clipboard images are only readable from the local UI".to_string());
    }

    // Away from Linux the paste event already carries images and the shim that
    // would call this is never installed, so there is nothing to read.
    #[cfg(not(target_os = "linux"))]
    return Ok(None);

    #[cfg(target_os = "linux")]
    tauri::async_runtime::spawn_blocking(read_png_data_url)
        .await
        .map_err(|error| format!("clipboard read task failed: {error}"))?
}

/// Blocking half of [`read_clipboard_image`], kept off the async worker because
/// clipboard access and PNG encoding are both synchronous.
#[cfg(target_os = "linux")]
fn read_png_data_url() -> Result<Option<String>, String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("clipboard unavailable: {error}"))?;

    let image = match clipboard.get_image() {
        Ok(image) => image,
        // An empty clipboard, or one holding only text, is the common case.
        Err(arboard::Error::ContentNotAvailable) => return Ok(None),
        Err(error) => return Err(format!("could not read the clipboard image: {error}")),
    };

    let width = u32::try_from(image.width).map_err(|_| "clipboard image is too wide".to_string())?;
    let height =
        u32::try_from(image.height).map_err(|_| "clipboard image is too tall".to_string())?;
    if u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
        return Err(format!(
            "clipboard image is too large: {width}x{height} exceeds {MAX_IMAGE_PIXELS} pixels"
        ));
    }

    let rgba = image::RgbaImage::from_raw(width, height, image.bytes.into_owned())
        .ok_or_else(|| "clipboard image data was truncated".to_string())?;

    let mut png = std::io::Cursor::new(Vec::new());
    rgba.write_to(&mut png, image::ImageFormat::Png)
        .map_err(|error| format!("could not encode the clipboard image: {error}"))?;

    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(png.into_inner());

    Ok(Some(format!("data:image/png;base64,{encoded}")))
}

#[cfg(test)]
mod tests {
    use super::is_loopback;
    use tauri::utils::acl::RemoteUrlPattern;

    /// The capability's `remote.urls` must still match when the OS assigns an
    /// arbitrary port, which is the normal case (`launch.port` is 0). Pinned
    /// here because a silent mismatch would reproduce the original bug.
    #[test]
    fn capability_pattern_matches_an_arbitrary_port() {
        let cases = [
            (
                "http://127.0.0.1:*",
                ["http://127.0.0.1:38471/", "http://127.0.0.1:38471/?token=abc"],
            ),
            (
                "http://localhost:*",
                ["http://localhost:38471/", "http://localhost:38471/?token=abc"],
            ),
        ];
        for (pattern, urls) in cases {
            let pattern: RemoteUrlPattern = pattern.parse().expect("pattern must parse");
            for url in urls {
                let url: url::Url = url.parse().expect("test URL must parse");
                assert!(pattern.test(&url), "{url} must match the capability pattern");
            }
        }
    }

    #[test]
    fn loopback_origins_are_accepted() {
        for origin in [
            "http://127.0.0.1:38471/",
            "http://127.0.0.1:38471/?token=abc",
            "http://localhost:1234/index.html",
            "http://[::1]:8080/",
        ] {
            let url: url::Url = origin.parse().expect("test URL must parse");
            assert!(is_loopback(&url), "{origin} should be treated as local");
        }
    }

    #[test]
    fn other_origins_are_rejected() {
        for origin in [
            "https://example.com/",
            "http://192.168.1.10:8080/",
            "http://notlocalhost.example/",
            "file:///etc/passwd",
        ] {
            let url: url::Url = origin.parse().expect("test URL must parse");
            assert!(!is_loopback(&url), "{origin} must not be treated as local");
        }
    }
}
