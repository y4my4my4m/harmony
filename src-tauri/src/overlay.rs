use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const OVERLAY_LABEL: &str = "overlay";

#[tauri::command]
pub fn overlay_open(app: AppHandle) -> Result<(), String> {
  if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
    let _ = w.show();
    return Ok(());
  }
  let win = WebviewWindowBuilder::new(
    &app,
    OVERLAY_LABEL,
    WebviewUrl::App("index.html?overlay=1".into()),
  )
  .title("Harmony Overlay")
  .transparent(true)
  .decorations(false)
  .always_on_top(true)
  .skip_taskbar(true)
  .shadow(false)
  .resizable(true)
  .inner_size(280.0, 360.0)
  .position(40.0, 80.0)
  .build()
  .map_err(|e| e.to_string())?;
  // click-through by default so the game underneath stays interactive
  win.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
  Ok(())
}

#[tauri::command]
pub fn overlay_close(app: AppHandle) {
  if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
    let _ = w.close();
  }
}

// interactive = clickable (buttons work); non-interactive = click-through
#[tauri::command]
pub fn overlay_set_interactive(app: AppHandle, interactive: bool) -> Result<(), String> {
  if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
    w.set_ignore_cursor_events(!interactive)
      .map_err(|e| e.to_string())?;
    app
      .state::<OverlayInteractive>()
      .0
      .store(interactive, std::sync::atomic::Ordering::SeqCst);
    if interactive {
      let _ = w.set_focus();
    }
  }
  Ok(())
}

// global-shortcut handler: flip interactive/click-through and tell the overlay UI
pub fn toggle_interactive(app: &AppHandle) {
  use std::sync::atomic::Ordering;
  if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
    let state = app.state::<OverlayInteractive>();
    let next = !state.0.fetch_xor(true, Ordering::SeqCst);
    let _ = w.set_ignore_cursor_events(!next);
    if next {
      let _ = w.set_focus();
    }
    let _ = w.emit_to(OVERLAY_LABEL, "overlay://interactive", next);
  }
}

use tauri::Emitter;

#[derive(Default)]
pub struct OverlayInteractive(pub std::sync::atomic::AtomicBool);
