//! Program audio for a desktop screen share, captured natively: the webview's getDisplayMedia
//! returns no audio from WebKit, and from WebView2 only for whole screens.
//!
//! Windows: WASAPI process loopback (Windows 10 2004, build 19041+). macOS: ScreenCaptureKit
//! (macOS 13+, Screen Recording permission). Both exclude this process tree, so the call's own
//! playback never reaches the stream.
//!
//! Output: interleaved stereo signed 16-bit PCM at 48 kHz, in blocks of any length.

#[cfg(target_os = "macos")]
mod sck;
#[cfg(windows)]
mod wasapi;

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: usize = 2;

/// Receives captured audio on the capture thread.
pub type Sink = Box<dyn FnMut(&[i16]) + Send + 'static>;

/// What the shared surface's track reports, from getDisplayMedia.
#[derive(Debug, Clone, Default)]
pub struct SharedSurface {
  /// MediaStreamTrack.label.
  pub label: String,
  /// MediaTrackSettings.displaySurface: "monitor", "window", "browser" or empty.
  pub display_surface: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
  /// Every application except this one.
  System,
  /// The application owning a window.
  Window(WindowRef),
  /// An application named directly.
  App(AppRef),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowRef {
  /// HWND on Windows, CGWindowID on macOS.
  Id(u64),
  /// Window title, for webviews whose labels carry no id.
  Title(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppRef {
  Pid(u32),
  /// Bundle identifier on macOS, executable file name on Windows.
  Bundle(String),
}

/// A shareable window, as capture resolves it.
#[derive(Debug, Clone)]
pub struct WindowInfo {
  /// HWND on Windows, CGWindowID on macOS.
  pub id: u64,
  pub title: String,
  /// Owning application's process.
  pub pid: u32,
  pub app: String,
}

/// A process capture can name, with what ties it to its application.
#[derive(Debug, Clone)]
pub struct AppInfo {
  pub pid: u32,
  pub name: String,
  /// Bundle identifier on macOS, executable file name on Windows.
  pub bundle: String,
  /// macOS: the process TCC and the audio system attribute this one to.
  pub responsible: Option<u32>,
  /// Owns a shareable window.
  pub windowed: bool,
}

impl Target {
  /// Chromium (WebView2) labels a window capture `window:<id>:<n>`, the DesktopMediaID string,
  /// where `<id>` is the HWND. WebKit labels it with the window's title. A screen, a tab or an
  /// unrecognised label captures the whole system.
  pub fn from_surface(surface: &SharedSurface) -> Target {
    if surface.display_surface != "window" {
      return Target::System;
    }
    let label = surface.label.trim();
    if let Some(rest) = label.strip_prefix("window:") {
      if let Some(id) = rest.split(':').next().and_then(|s| s.parse::<u64>().ok()) {
        if id != 0 {
          return Target::Window(WindowRef::Id(id));
        }
      }
      return Target::System;
    }
    if label.is_empty() {
      return Target::System;
    }
    Target::Window(WindowRef::Title(label.to_string()))
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
  /// All applications except this one.
  System,
  /// One application and its child processes.
  App,
}

#[derive(Debug, Clone)]
pub struct Started {
  pub scope: Scope,
  /// Display name of the captured application when `scope` is `App`.
  pub app: Option<String>,
  /// How the target resolved, for logs.
  pub detail: String,
}

#[derive(Debug)]
pub enum Error {
  /// The OS or its version lacks the capture API.
  Unsupported(String),
  /// The user has not granted capture (macOS Screen Recording).
  Permission(String),
  Failed(String),
}

impl std::fmt::Display for Error {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Error::Unsupported(m) => write!(f, "unsupported: {m}"),
      Error::Permission(m) => write!(f, "permission: {m}"),
      Error::Failed(m) => write!(f, "failed: {m}"),
    }
  }
}

impl std::error::Error for Error {}

/// A running capture; dropping it stops the capture and releases the sink.
pub struct Capture {
  /// Held for its Drop, which stops the capture.
  #[cfg(any(windows, target_os = "macos"))]
  _inner: platform::Capture,
}

impl Capture {
  pub fn stop(self) {}
}

#[cfg(windows)]
use self::wasapi as platform;
#[cfg(target_os = "macos")]
use self::sck as platform;

/// Ok when this OS can capture program audio; the reason otherwise.
pub fn support() -> Result<(), Error> {
  #[cfg(any(windows, target_os = "macos"))]
  {
    platform::support()
  }
  #[cfg(not(any(windows, target_os = "macos")))]
  {
    Err(Error::Unsupported("no native program-audio capture on this OS".into()))
  }
}

/// The capture permission as the OS reports it without prompting: macOS Screen Recording.
/// None where capture needs no permission.
pub fn permission_granted() -> Option<bool> {
  #[cfg(target_os = "macos")]
  {
    Some(sck::permission_granted())
  }
  #[cfg(not(target_os = "macos"))]
  {
    None
  }
}

/// Shareable windows, on-screen ones first.
pub fn windows() -> Result<Vec<WindowInfo>, Error> {
  #[cfg(any(windows, target_os = "macos"))]
  {
    platform::windows()
  }
  #[cfg(not(any(windows, target_os = "macos")))]
  {
    Err(Error::Unsupported("no native program-audio capture on this OS".into()))
  }
}

/// Applications capture can include. macOS: ScreenCaptureKit's list, which holds processes
/// without windows as well. Windows: owners of visible top-level windows.
pub fn applications() -> Result<Vec<AppInfo>, Error> {
  #[cfg(any(windows, target_os = "macos"))]
  {
    platform::applications()
  }
  #[cfg(not(any(windows, target_os = "macos")))]
  {
    Err(Error::Unsupported("no native program-audio capture on this OS".into()))
  }
}

/// Indices of the titles a picker label names. Exact matches win; failing those, titles that
/// contain the label or are contained in it, compared without a leading unread counter and at
/// least MIN_PARTIAL_TITLE characters on the shorter side. The label is the title at pick
/// time; a page can retitle its window since (a counter such as YouTube's "(4) ", a browser's
/// "Audio playing" suffix).
#[cfg(any(windows, target_os = "macos", test))]
pub(crate) fn titled(titles: &[String], label: &str) -> Vec<usize> {
  let label = label.trim();
  if label.is_empty() {
    return Vec::new();
  }
  let exact: Vec<usize> = (0..titles.len()).filter(|&i| titles[i].trim() == label).collect();
  if !exact.is_empty() {
    return exact;
  }
  let label = without_counter(label);
  (0..titles.len())
    .filter(|&i| {
      let title = without_counter(titles[i].trim());
      let shorter = title.chars().count().min(label.chars().count());
      shorter >= MIN_PARTIAL_TITLE && (title.contains(label) || label.contains(title))
    })
    .collect()
}

/// "(4) Title" and "(99+) Title" to "Title".
#[cfg(any(windows, target_os = "macos", test))]
fn without_counter(title: &str) -> &str {
  let Some(rest) = title.strip_prefix('(') else { return title };
  let Some((count, tail)) = rest.split_once(") ") else { return title };
  let digits = count.strip_suffix('+').unwrap_or(count);
  if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
    tail.trim_start()
  } else {
    title
  }
}

/// Shortest title or label a partial match accepts.
#[cfg(any(windows, target_os = "macos", test))]
const MIN_PARTIAL_TITLE: usize = 8;

/// Starts capturing `target`. A window whose application cannot be resolved falls back to
/// `Target::System`; `Started::scope` reports which one runs.
pub fn start(target: Target, sink: Sink) -> Result<(Capture, Started), Error> {
  #[cfg(any(windows, target_os = "macos"))]
  {
    let (inner, started) = platform::start(target, sink)?;
    Ok((Capture { _inner: inner }, started))
  }
  #[cfg(not(any(windows, target_os = "macos")))]
  {
    let _ = (target, sink);
    Err(Error::Unsupported("no native program-audio capture on this OS".into()))
  }
}

/// f32 samples in [-1, 1] to s16, clamped.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn f32_to_i16(x: f32) -> i16 {
  (x.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
}

#[cfg(test)]
mod tests {
  use super::*;

  fn surface(label: &str, display_surface: &str) -> SharedSurface {
    SharedSurface { label: label.into(), display_surface: display_surface.into() }
  }

  #[test]
  fn chromium_window_label_gives_the_hwnd() {
    assert_eq!(
      Target::from_surface(&surface("window:132456:0", "window")),
      Target::Window(WindowRef::Id(132456))
    );
  }

  #[test]
  fn screens_and_tabs_capture_the_system() {
    assert_eq!(Target::from_surface(&surface("screen:0:0", "monitor")), Target::System);
    assert_eq!(Target::from_surface(&surface("web-contents-media-stream://1:2", "browser")), Target::System);
  }

  #[test]
  fn malformed_or_zero_window_ids_capture_the_system() {
    assert_eq!(Target::from_surface(&surface("window:abc:0", "window")), Target::System);
    assert_eq!(Target::from_surface(&surface("window:0:0", "window")), Target::System);
    assert_eq!(Target::from_surface(&surface("", "window")), Target::System);
  }

  #[test]
  fn other_window_labels_are_titles() {
    assert_eq!(
      Target::from_surface(&surface("  Spotify Premium ", "window")),
      Target::Window(WindowRef::Title("Spotify Premium".into()))
    );
  }

  fn titles(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
  }

  #[test]
  fn exact_titles_win_over_partial_ones() {
    let list = titles(&["Harmony probe tone - Google Chrome", "Harmony probe tone", "Other"]);
    assert_eq!(titled(&list, "Harmony probe tone"), vec![1]);
  }

  #[test]
  fn retitled_windows_match_partially() {
    let list = titles(&["(5) Semifinals - ESL Pro League - YouTube", "Finder"]);
    assert_eq!(titled(&list, "(4) Semifinals - ESL Pro League - YouTube"), vec![0]);
    assert_eq!(titled(&list, "Semifinals - ESL Pro League - YouTube"), vec![0]);
    assert_eq!(without_counter("(99+) Inbox"), "Inbox");
    assert_eq!(without_counter("(draft) Notes"), "(draft) Notes");
    let list = titles(&["Semifinals - ESL Pro League - YouTube - Audio playing"]);
    assert_eq!(titled(&list, "Semifinals - ESL Pro League - YouTube"), vec![0]);
  }

  #[test]
  fn short_partial_titles_do_not_match() {
    let list = titles(&["Mail", "Mail - Inbox (3 messages)"]);
    assert_eq!(titled(&list, "Mail - Inbox"), vec![1]);
    assert_eq!(titled(&list, "Inbox"), Vec::<usize>::new());
    assert_eq!(titled(&list, "  "), Vec::<usize>::new());
  }

  #[test]
  fn f32_conversion_clamps() {
    assert_eq!(f32_to_i16(2.0), i16::MAX);
    assert_eq!(f32_to_i16(-2.0), -i16::MAX);
    assert_eq!(f32_to_i16(0.0), 0);
  }
}
