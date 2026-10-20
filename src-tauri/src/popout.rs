//! The call pop-out (src/components/voice/callPopout.ts) opens with
//! `window.open('about:blank', 'harmony-call', 'popup,width=..,height=..')` and
//! moves the live call view into the new document, so the window must share the
//! opener's JS context. wry gives window.open a window only through a new-window
//! handler, and links it to the opener only when the handler builds it from the
//! request's features. Any other window.open is refused, as wry does with no
//! handler set.
//!
//! Linux runs CEF, which opens window.open as its own popup with the opener
//! linked when no handler is set; there the main window takes no handler.

use std::sync::atomic::{AtomicU32, Ordering};

use tauri::webview::{NewWindowFeatures, NewWindowResponse, Url};
use tauri::{AppHandle, EventLoopMessage, Runtime, WebviewUrl, WebviewWindowBuilder};

/// Pop-out windows are not reused: a closing one may still hold the previous label.
static NEXT_LABEL: AtomicU32 = AtomicU32::new(0);

/// CSS px.
const MIN_SIZE: (f64, f64) = (480.0, 320.0);

pub fn on_new_window<R: Runtime>(
  app: &AppHandle<R>,
  url: Url,
  features: NewWindowFeatures<EventLoopMessage, R>,
) -> NewWindowResponse<R> {
  if url.as_str() != "about:blank" {
    return NewWindowResponse::Deny;
  }
  let label = format!("call-popout-{}", NEXT_LABEL.fetch_add(1, Ordering::Relaxed));
  let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
    .window_features(features)
    .title("Harmony")
    .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
    .on_document_title_changed(|window, title| {
      let _ = window.set_title(&title);
    });
  match builder.build() {
    Ok(window) => NewWindowResponse::Create { window },
    Err(e) => {
      eprintln!("[popout] could not open the call window: {e}");
      NewWindowResponse::Deny
    }
  }
}
