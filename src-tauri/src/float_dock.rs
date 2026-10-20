//! The floating voice dock: the minimized call controls in a borderless, always-on-top
//! window of their own, so they stay over other applications. The window loads this bundle
//! at index.html?dock=1 (src/overlay/FloatingDockApp.vue), which holds no call state: the
//! main window drives it over events (src/services/floatingDock.ts).

use tauri::{AppHandle, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};

pub const FLOAT_DOCK_LABEL: &str = "dock";

/// Logical px. The dock page sizes the window to its content once mounted.
const INITIAL_SIZE: (f64, f64) = (360.0, 56.0);

/// Opens the dock window with its top-left at `x`, `y` (logical screen px), or moves the
/// open one there.
#[tauri::command]
pub fn float_dock_open(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
  if let Some(w) = app.get_webview_window(FLOAT_DOCK_LABEL) {
    w.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    let _ = w.show();
    return Ok(());
  }
  // A windowed CEF browser cannot paint transparent (overlay.rs): Linux gets an opaque
  // panel, `panel=1` selects its layout.
  #[cfg(target_os = "linux")]
  let (url, transparent) = ("index.html?dock=1&panel=1", false);
  #[cfg(not(target_os = "linux"))]
  let (url, transparent) = ("index.html?dock=1", true);

  let builder = WebviewWindowBuilder::new(&app, FLOAT_DOCK_LABEL, WebviewUrl::App(url.into()))
    .title("Harmony call")
    .transparent(transparent)
    .decorations(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .shadow(false)
    .resizable(false)
    .focused(false)
    .inner_size(INITIAL_SIZE.0, INITIAL_SIZE.1)
    .position(x, y);
  // Matches the dock panel background in FloatingDockApp.vue.
  #[cfg(target_os = "linux")]
  let builder = builder.background_color(tauri::window::Color(30, 31, 34, 255));
  builder.build().map_err(|e| e.to_string())?;
  Ok(())
}

#[tauri::command]
pub fn float_dock_close(app: AppHandle) {
  if let Some(w) = app.get_webview_window(FLOAT_DOCK_LABEL) {
    let _ = w.close();
  }
}

/// Brings the main window forward: unminimized, shown and focused.
#[tauri::command]
pub fn float_dock_focus_main(app: AppHandle) {
  if let Some(w) = app.get_webview_window("main") {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
  }
}
