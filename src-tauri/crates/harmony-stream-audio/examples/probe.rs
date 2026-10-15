//! Captures program audio for a few seconds and reports what arrived.
//!
//!   probe [--seconds N] [--expect-hz F] system
//!   probe [--seconds N] [--expect-hz F] app <pid | bundle id | executable name>
//!   probe [--seconds N] [--expect-hz F] window <title substring>
//!   probe list [process name substring]
//!
//! `window` finds a shareable window whose title contains the substring and captures it through
//! the label the desktop app receives from getDisplayMedia: `window:<hwnd>:0` from WebView2, the
//! full window title from WebKit. Something else must play sound meanwhile; this process is
//! excluded. `list` prints what capture can name: windows, applications and, on macOS, every
//! process matching the substring with its responsible process.
//!
//! Exit status: 0 audible audio, at the expected pitch with --expect-hz; 1 silence; 2 capture did
//! not start; 3 an app or window target fell back to the whole system; 4 wrong pitch; 5 no such
//! window; 64 usage.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use harmony_stream_audio::{self as audio, AppRef, Scope, SharedSurface, Target};

/// -40 dBFS. The CI sources play at -12 dBFS.
const AUDIBLE_PEAK: u16 = 328;
/// Accepted pitch error, relative.
const PITCH_TOLERANCE: f64 = 0.1;

/// The crate's log records on stderr, unbuffered, so a crash keeps the steps before it.
struct Stderr;

impl log::Log for Stderr {
  fn enabled(&self, _: &log::Metadata) -> bool {
    true
  }
  fn log(&self, record: &log::Record) {
    eprintln!("[{}] {}", record.level(), record.args());
  }
  fn flush(&self) {}
}

static LOGGER: Stderr = Stderr;

fn usage() -> ! {
  eprintln!("usage: probe [--seconds N] [--expect-hz F] system | app <pid|bundle> | window <title substring> | list [name]");
  std::process::exit(64);
}

fn dbfs(peak: u16) -> String {
  if peak == 0 {
    "-inf".into()
  } else {
    format!("{:.1}", 20.0 * (peak as f64 / i16::MAX as f64).log10())
  }
}

/// What the sink has seen.
#[derive(Default, Clone, Copy)]
struct Stats {
  samples: usize,
  calls: usize,
  peak: u16,
  /// Left-channel sign changes with hysteresis, over audible blocks only.
  flips: u64,
  /// Frames of the audible blocks.
  audible_frames: u64,
  /// Last hysteresis state of the left channel: -1, 0, 1.
  side: i8,
}

impl Stats {
  fn add(&mut self, samples: &[i16]) {
    self.samples += samples.len();
    self.calls += 1;
    let block_peak = samples.iter().fold(0u16, |p, x| p.max(x.unsigned_abs()));
    self.peak = self.peak.max(block_peak);
    if block_peak < AUDIBLE_PEAK {
      return;
    }
    let threshold = (block_peak / 4) as i32;
    for frame in samples.chunks_exact(audio::CHANNELS) {
      let x = frame[0] as i32;
      let side = if x > threshold {
        1
      } else if x < -threshold {
        -1
      } else {
        continue;
      };
      if self.side != 0 && side != self.side {
        self.flips += 1;
      }
      self.side = side;
    }
    self.audible_frames += (samples.len() / audio::CHANNELS) as u64;
  }

  /// Zero-crossing pitch of the audible blocks, Hz.
  fn pitch(&self) -> Option<f64> {
    (self.audible_frames > 0).then(|| self.flips as f64 / 2.0 / (self.audible_frames as f64 / audio::SAMPLE_RATE as f64))
  }
}

/// The label getDisplayMedia gives the desktop app for this window.
fn window_label(window: &audio::WindowInfo) -> String {
  if cfg!(windows) {
    format!("window:{}:0", window.id)
  } else {
    window.title.clone()
  }
}

fn list(filter: Option<&str>) {
  match audio::windows() {
    Ok(windows) => {
      println!("windows ({}):", windows.len());
      for w in windows {
        println!("  id {} pid {} [{}] {:?}", w.id, w.pid, w.app, w.title);
      }
    }
    Err(e) => println!("windows: {e}"),
  }
  match audio::applications() {
    Ok(apps) => {
      println!("applications ({}):", apps.len());
      for a in apps {
        println!(
          "  pid {} responsible {:?} windowed {} {:?} ({})",
          a.pid, a.responsible, a.windowed, a.name, a.bundle
        );
      }
    }
    Err(e) => println!("applications: {e}"),
  }
  #[cfg(target_os = "macos")]
  if let Some(filter) = filter {
    macos::processes(filter);
  }
  #[cfg(not(target_os = "macos"))]
  let _ = filter;
}

#[cfg(target_os = "macos")]
mod macos {
  use std::ffi::c_void;

  type ResponsibleFn = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;

  fn responsible(pid: libc::pid_t) -> Option<libc::pid_t> {
    let sym = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"responsibility_get_pid_responsible_for_pid".as_ptr()) };
    (!sym.is_null()).then(|| unsafe { std::mem::transmute::<*mut c_void, ResponsibleFn>(sym)(pid) })
  }

  /// Every process whose executable path contains `filter`, with its responsible process and
  /// whether ScreenCaptureKit lists it as an application.
  pub fn processes(filter: &str) {
    let listed: Vec<u32> = harmony_stream_audio::applications().unwrap_or_default().iter().map(|a| a.pid).collect();
    let mut pids = vec![0 as libc::pid_t; 8192];
    let n = unsafe { libc::proc_listallpids(pids.as_mut_ptr() as *mut c_void, (pids.len() * 4) as libc::c_int) };
    println!("processes matching {filter:?}:");
    for &pid in &pids[..n.max(0) as usize] {
      let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
      let len = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr() as *mut c_void, buf.len() as u32) };
      if len <= 0 {
        continue;
      }
      let path = String::from_utf8_lossy(&buf[..len as usize]).to_string();
      if !path.contains(filter) {
        continue;
      }
      println!(
        "  pid {pid} responsible {:?} listed {} {}",
        responsible(pid),
        listed.contains(&(pid as u32)),
        path
      );
    }
  }
}

fn main() {
  let _ = log::set_logger(&LOGGER).map(|()| log::set_max_level(log::LevelFilter::Debug));
  let mut seconds: u64 = 6;
  let mut expect_hz: Option<f64> = None;
  let mut rest: Vec<String> = Vec::new();
  let mut args = std::env::args().skip(1);
  while let Some(arg) = args.next() {
    match arg.as_str() {
      "--seconds" => seconds = args.next().and_then(|s| s.parse().ok()).unwrap_or_else(|| usage()),
      "--expect-hz" => expect_hz = Some(args.next().and_then(|s| s.parse().ok()).unwrap_or_else(|| usage())),
      _ => rest.push(arg),
    }
  }
  println!("support: {:?}", audio::support());
  println!("permission: {:?}", audio::permission_granted());

  let target = match rest.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
    ["list"] => return list(None),
    ["list", filter] => return list(Some(filter)),
    ["system"] => Target::System,
    ["app", app] => Target::App(match app.parse::<u32>() {
      Ok(pid) => AppRef::Pid(pid),
      Err(_) => AppRef::Bundle(app.to_string()),
    }),
    ["window", substring] => {
      let windows = audio::windows().unwrap_or_else(|e| {
        println!("windows: {e}");
        std::process::exit(2);
      });
      let Some(window) = windows.iter().find(|w| w.title.contains(substring)) else {
        println!("no window title contains {substring:?}; titles: {:?}", windows.iter().map(|w| &w.title).collect::<Vec<_>>());
        std::process::exit(5);
      };
      let surface = SharedSurface { label: window_label(window), display_surface: "window".into() };
      println!("window: id {} pid {} [{}] {:?}; label {:?}", window.id, window.pid, window.app, window.title, surface.label);
      Target::from_surface(&surface)
    }
    _ => usage(),
  };
  println!("target: {target:?}");
  let wants_app = !matches!(target, Target::System);

  let stats = Arc::new(Mutex::new(Stats::default()));
  let shared = Arc::clone(&stats);
  let sink: audio::Sink = Box::new(move |samples: &[i16]| {
    if let Ok(mut s) = shared.lock() {
      s.add(samples);
    }
  });

  let (capture, started) = match audio::start(target, sink) {
    Ok(ok) => ok,
    Err(e) => {
      println!("start failed: {e}");
      std::process::exit(2);
    }
  };
  println!("started: {:?} app={:?} detail={}", started.scope, started.app, started.detail);
  for second in 1..=seconds {
    std::thread::sleep(Duration::from_secs(1));
    let s = *stats.lock().unwrap();
    println!("t={second}s samples={} calls={} peak={} ({} dBFS)", s.samples, s.calls, s.peak, dbfs(s.peak));
  }
  capture.stop();

  let s = *stats.lock().unwrap();
  let frames = s.samples / audio::CHANNELS;
  let expected = audio::SAMPLE_RATE as usize * seconds as usize;
  let pitch = s.pitch();
  println!(
    "result: scope {:?}, frames {frames} of ~{expected}, peak {} ({} dBFS, audible >= {AUDIBLE_PEAK}), pitch {}",
    started.scope,
    s.peak,
    dbfs(s.peak),
    pitch.map_or("n/a".into(), |hz| format!("{hz:.0} Hz"))
  );
  if wants_app && started.scope != Scope::App {
    println!("FAIL: the target fell back to the whole system");
    std::process::exit(3);
  }
  if s.samples == 0 || s.peak < AUDIBLE_PEAK {
    println!("FAIL: silence");
    std::process::exit(1);
  }
  if let (Some(want), Some(got)) = (expect_hz, pitch) {
    if (got - want).abs() > want * PITCH_TOLERANCE {
      println!("FAIL: pitch {got:.0} Hz, expected {want:.0} Hz");
      std::process::exit(4);
    }
  }
  println!("PASS");
}
