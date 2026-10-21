//! Pages outside the app open outside it: in the system browser, or on Android in the app that
//! handles the URL (YouTube, Spotify). The page's own link handling (src/services/tauriLinks.ts)
//! covers anchors in the app; this covers what reaches the main window as a navigation instead:
//! links inside embedded players ("Watch on YouTube"), and window.open, which the Android WebView
//! loads in place without multi-window support.
//!
//! The handler sees main-frame navigations only on Android (shouldOverrideUrlLoading is not
//! consulted for http(s) subframes), Windows (WebView2 NavigationStarting) and Linux (CEF
//! on_before_browse checks frame.is_main()). wry 0.57's WKWebView navigation policy passes every
//! WKNavigationAction, subframes included, with its URL alone; on macOS and iOS a delegate in
//! front of wry's reports the frame (apple_navigation.rs), and subframes load in place.
//!
//! A sign-in started on the instance (Supabase's `/auth/v1/authorize`) runs in the window, as the
//! mobile apps sign in (AuthComponent.vue), until an app page loads again or SIGN_IN_TTL passes.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Runtime, Url};

/// A sign-in left mid-way (Back from the provider, a closed tab) stops admitting outside pages.
const SIGN_IN_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
  /// The app's own pages; ends a sign-in.
  App,
  /// Not a web page the app owns or leaves to (about:, data:, blob:, javascript:); the sign-in
  /// state is unchanged.
  Other,
  /// The instance's sign-in, and every page until the window is back on the app.
  SignIn,
  /// Opened outside the app; the window stays where it is.
  OpenOutside,
  /// A scheme the WebView cannot show (mailto:, tel:, intent:): the Android WebView would replace
  /// the app with an ERR_UNKNOWN_URL_SCHEME page.
  Refuse,
}

/// The app's own pages: tauri://localhost, http(s)://tauri.localhost (Android, Windows), the asset
/// and IPC hosts (*.localhost), and the dev server in dev builds.
pub fn is_app_url(url: &Url) -> bool {
  if url.scheme() == "tauri" {
    return true;
  }
  if !matches!(url.scheme(), "http" | "https") {
    return false;
  }
  match url.host_str() {
    Some(host) if host.ends_with(".localhost") => true,
    Some("localhost" | "127.0.0.1" | "[::1]") => cfg!(dev),
    _ => false,
  }
}

pub fn decide(url: &Url, signing_in: bool) -> Decision {
  match url.scheme() {
    "http" | "https" => {
      if is_app_url(url) {
        Decision::App
      } else if signing_in || url.path().ends_with("/auth/v1/authorize") {
        Decision::SignIn
      } else {
        Decision::OpenOutside
      }
    }
    "tauri" => Decision::App,
    "about" | "data" | "blob" | "javascript" => Decision::Other,
    _ if cfg!(target_os = "android") => Decision::Refuse,
    _ => Decision::Other,
  }
}

/// The frame a navigation loads in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Frame {
  /// The window's page, or a new window's (window.open, target=_blank).
  Main,
  /// An iframe: an embedded player and the pages inside it. Only WKWebView reports one.
  #[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
  Sub,
}

/// What the main window does with a navigation.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
  Allow,
  Deny,
  OpenOutside,
}

/// Sign-in state shared by the navigation and page-load handlers of one window.
#[derive(Clone, Default)]
pub struct Navigator {
  sign_in_since: Arc<Mutex<Option<Instant>>>,
}

impl Navigator {
  fn signing_in(&self, now: Instant) -> bool {
    let since = *self.sign_in_since.lock().unwrap_or_else(|e| e.into_inner());
    since.is_some_and(|t| now.saturating_duration_since(t) < SIGN_IN_TTL)
  }

  fn set(&self, value: Option<Instant>) {
    *self.sign_in_since.lock().unwrap_or_else(|e| e.into_inner()) = value;
  }

  pub fn on_navigation(&self, url: &Url, now: Instant) -> Verdict {
    match decide(url, self.signing_in(now)) {
      Decision::App => {
        self.set(None);
        Verdict::Allow
      }
      Decision::Other => Verdict::Allow,
      Decision::SignIn => {
        self.set(Some(now));
        Verdict::Allow
      }
      Decision::OpenOutside => Verdict::OpenOutside,
      Decision::Refuse => Verdict::Deny,
    }
  }

  /// A subframe loads in place and leaves the sign-in state as it is.
  pub fn on_frame_navigation(&self, frame: Frame, url: &Url, now: Instant) -> Verdict {
    match frame {
      Frame::Main => self.on_navigation(url, now),
      Frame::Sub => Verdict::Allow,
    }
  }

  /// A page started loading in the main frame. History navigations (Back, which Android maps to
  /// WebView.goBack) never reach the navigation handler, only this.
  pub fn on_page_started(&self, url: &Url) {
    if is_app_url(url) {
      self.set(None);
    }
  }
}

/// For the main window's navigation handler: true lets the navigation happen.
pub fn navigate<R: Runtime>(app: &AppHandle<R>, navigator: &Navigator, frame: Frame, url: &Url) -> bool {
  match navigator.on_frame_navigation(frame, url, Instant::now()) {
    Verdict::Allow => true,
    Verdict::Deny => false,
    Verdict::OpenOutside => {
      open_outside(app, url);
      false
    }
  }
}

pub fn open_outside<R: Runtime>(app: &AppHandle<R>, url: &Url) {
  // The opener's mobile call blocks until the plugin replies from Tauri's ipc queue; the
  // navigation delegate (apple_navigation.rs) runs on the main thread.
  #[cfg(target_os = "ios")]
  {
    let (app, url) = (app.clone(), url.clone());
    std::thread::spawn(move || open_now(&app, &url));
  }
  #[cfg(not(target_os = "ios"))]
  open_now(app, url);
}

fn open_now<R: Runtime>(app: &AppHandle<R>, url: &Url) {
  #[cfg(target_os = "android")]
  let result = {
    let _ = app;
    crate::commands::media::android_open_url(url.to_string())
  };
  #[cfg(not(target_os = "android"))]
  let result = {
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(url.as_str(), None::<&str>).map_err(|e| e.to_string())
  };
  if let Err(e) = result {
    // The host only: a sign-in URL carries its code in the query.
    eprintln!("[links] could not open {} outside the app: {e}", url.host_str().unwrap_or(url.scheme()));
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn u(url: &str) -> Url {
    Url::parse(url).unwrap()
  }

  fn d(url: &str, signing_in: bool) -> Decision {
    decide(&u(url), signing_in)
  }

  #[test]
  fn the_app_and_non_web_urls_stay() {
    assert_eq!(d("tauri://localhost/chat", false), Decision::App);
    assert_eq!(d("http://tauri.localhost/chat", false), Decision::App);
    assert_eq!(d("https://tauri.localhost/auth/callback", true), Decision::App);
    assert_eq!(d("http://asset.localhost/x.png", false), Decision::App);
    assert_eq!(d("about:blank", false), Decision::Other);
    assert_eq!(d("data:text/html,x", false), Decision::Other);
    assert_eq!(d("blob:https://tauri.localhost/1", true), Decision::Other);
  }

  #[test]
  fn the_dev_server_is_the_app_only_in_dev_builds() {
    let expected = if cfg!(dev) { Decision::App } else { Decision::OpenOutside };
    assert_eq!(d("http://localhost:5173/", false), expected);
    assert_eq!(d("http://127.0.0.1:5173/", false), expected);
  }

  #[test]
  fn other_web_pages_open_outside() {
    assert_eq!(d("https://www.youtube.com/watch?v=dQw4w9WgXcQ", false), Decision::OpenOutside);
    assert_eq!(d("https://open.spotify.com/track/x", false), Decision::OpenOutside);
    assert_eq!(d("http://example.com/", false), Decision::OpenOutside);
  }

  #[test]
  fn a_scheme_the_webview_cannot_show() {
    let expected = if cfg!(target_os = "android") { Decision::Refuse } else { Decision::Other };
    assert_eq!(d("mailto:someone@example.com", false), expected);
    assert_eq!(d("intent://scan/#Intent;scheme=zxing;end", true), expected);
  }

  #[test]
  fn a_sign_in_runs_in_place_until_back_on_the_app() {
    let n = Navigator::default();
    let t = Instant::now();
    assert_eq!(n.on_navigation(&u("https://www.youtube.com/"), t), Verdict::OpenOutside);
    assert_eq!(n.on_navigation(&u("https://db.mony.lol/auth/v1/authorize?provider=github"), t), Verdict::Allow);
    assert_eq!(n.on_navigation(&u("https://github.com/login/oauth/authorize?client_id=x"), t), Verdict::Allow);
    // A provider page's about:blank frame or app-scheme probe leaves the sign-in running.
    assert_eq!(n.on_navigation(&u("about:blank"), t), Verdict::Allow);
    let _ = n.on_navigation(&u("intent://open#Intent;end"), t);
    assert_eq!(n.on_navigation(&u("https://db.mony.lol/auth/v1/callback?code=abc"), t), Verdict::Allow);
    assert_eq!(n.on_navigation(&u("http://tauri.localhost/auth/callback#access_token=x"), t), Verdict::Allow);
    // Back on the app: outside pages leave the app again.
    assert_eq!(n.on_navigation(&u("https://github.com/"), t), Verdict::OpenOutside);
  }

  #[test]
  fn backing_out_of_a_sign_in_ends_it() {
    let n = Navigator::default();
    let t = Instant::now();
    n.on_navigation(&u("https://db.mony.lol/auth/v1/authorize?provider=github"), t);
    // Back to the app: a history navigation, seen only as a page load.
    n.on_page_started(&u("http://tauri.localhost/login"));
    assert_eq!(n.on_navigation(&u("https://www.youtube.com/"), t), Verdict::OpenOutside);
  }

  #[test]
  fn an_abandoned_sign_in_expires() {
    let n = Navigator::default();
    let t = Instant::now();
    n.on_navigation(&u("https://db.mony.lol/auth/v1/authorize?provider=github"), t);
    assert_eq!(n.on_navigation(&u("https://github.com/x"), t + SIGN_IN_TTL - Duration::from_secs(1)), Verdict::Allow);
    assert_eq!(n.on_navigation(&u("https://www.youtube.com/"), t + 2 * SIGN_IN_TTL), Verdict::OpenOutside);
  }

  #[test]
  fn embedded_players_load_in_their_frames() {
    let n = Navigator::default();
    let t = Instant::now();
    for url in ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "https://open.spotify.com/embed/track/x"] {
      assert_eq!(n.on_frame_navigation(Frame::Sub, &u(url), t), Verdict::Allow);
      assert_eq!(n.on_frame_navigation(Frame::Main, &u(url), t), Verdict::OpenOutside);
    }
    assert_eq!(n.on_frame_navigation(Frame::Sub, &u("about:srcdoc"), t), Verdict::Allow);
    assert_eq!(n.on_frame_navigation(Frame::Main, &u("about:blank"), t), Verdict::Allow);
  }

  #[test]
  fn a_subframe_neither_starts_nor_ends_a_sign_in() {
    let n = Navigator::default();
    let t = Instant::now();
    n.on_frame_navigation(Frame::Sub, &u("https://db.mony.lol/auth/v1/authorize?provider=github"), t);
    assert_eq!(n.on_frame_navigation(Frame::Main, &u("https://github.com/"), t), Verdict::OpenOutside);

    n.on_frame_navigation(Frame::Main, &u("https://db.mony.lol/auth/v1/authorize?provider=github"), t);
    assert_eq!(n.on_frame_navigation(Frame::Sub, &u("tauri://localhost/"), t), Verdict::Allow);
    assert_eq!(n.on_frame_navigation(Frame::Sub, &u("http://tauri.localhost/"), t), Verdict::Allow);
    assert_eq!(n.on_frame_navigation(Frame::Main, &u("https://github.com/login"), t), Verdict::Allow);
  }
}
