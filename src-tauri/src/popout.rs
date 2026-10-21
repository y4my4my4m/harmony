//! The call pop-out (src/components/voice/callPopout.ts) opens with
//! `window.open('about:blank', 'harmony-call', 'popup,width=..,height=..')` and
//! moves the live call view into the new document, so the window must share the
//! opener's JS context. wry gives window.open a window only through a new-window
//! handler, and links it to the opener only when the handler builds it from the
//! request's features. Any other window.open is refused, as wry does with no
//! handler set; an http(s) one opens outside the app (external_links.rs).
//!
//! Linux runs CEF, which opens window.open('about:blank') as its own popup with
//! the opener linked; its main window allows that and sends any other window.open
//! outside (lib.rs).

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
    // A link in an embedded player opening a new window ("Watch on YouTube"): outside the app.
    if matches!(url.scheme(), "http" | "https") {
      crate::external_links::open_outside(app, &url);
    }
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
  // A third-party frame's window.open('') also lands here (an ad slot's sandbox allows popups);
  // the window then keeps only blank and app pages. Not on macOS, where WKWebView reports
  // subframe loads to the handler (external_links.rs).
  #[cfg(windows)]
  let builder = {
    let handle = app.clone();
    builder.on_navigation(move |url| {
      if url.as_str() == "about:blank" || crate::external_links::is_app_url(url) {
        return true;
      }
      if matches!(url.scheme(), "http" | "https") {
        crate::external_links::open_outside(&handle, url);
      }
      false
    })
  };
  match builder.build() {
    Ok(window) => NewWindowResponse::Create { window },
    Err(e) => {
      eprintln!("[popout] could not open the call window: {e}");
      NewWindowResponse::Deny
    }
  }
}
