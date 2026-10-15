//! Screen-share program audio for the webview (harmony-stream-audio). Captured PCM goes out in
//! 20 ms blocks of interleaved s16le stereo at 48 kHz, base64 encoded: a JSON channel message
//! under tauri's 8 KiB direct-execute threshold is evaluated in send order, while raw payloads
//! over 1 KiB are fetched asynchronously and can arrive reordered.
//!
//! Events go to <app log dir>/stream-audio.log (macOS ~/Library/Logs/online.knowmad.harmony,
//! Windows %LOCALAPPDATA%\online.knowmad.harmony\logs): release builds keep no other log.
//!
//! "Test audio capture" meters the running capture, or runs one of its own, without a stream.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use harmony_stream_audio as audio;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

/// 20 ms at 48 kHz: 3840 bytes, 5120 base64 characters.
const BLOCK_FRAMES: usize = 960;
/// Blocks between level reports: 5 s.
const REPORT_BLOCKS: u64 = 250;
const TRACE_FILE: &str = "stream-audio.log";
/// A log past this size starts over at the next launch.
const TRACE_MAX_BYTES: u64 = 512 * 1024;
const TRACE_MAX_LINE: usize = 2000;

/// Blocks between level reports to a test's meter: 100 ms.
const METER_BLOCKS: u64 = 5;
/// Level reported for digital silence, dBFS.
const SILENCE_DBFS: f32 = -100.0;
/// System Settings → Privacy & Security → Screen & System Audio Recording.
const SCREEN_RECORDING_SETTINGS: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/// What a capture records, as the webview shows it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
  /// "system" or "app".
  scope: &'static str,
  app: Option<String>,
  detail: String,
}

impl From<audio::Started> for Source {
  fn from(started: audio::Started) -> Self {
    Source {
      scope: match started.scope {
        audio::Scope::System => "system",
        audio::Scope::App => "app",
      },
      app: started.app,
      detail: started.detail,
    }
  }
}

struct Running {
  session: u64,
  source: Source,
  /// Held for its Drop, which stops the capture.
  _capture: audio::Capture,
}

static CAPTURE: Mutex<Option<Running>> = Mutex::new(None);
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

/// A test's level feed. Every block of whichever capture runs passes through it.
struct Meter {
  channel: Channel<f32>,
  /// Peak since the last report.
  pending: u16,
  peak: u16,
  blocks: u64,
}

static METER: Mutex<Option<Meter>> = Mutex::new(None);

fn meter_block(peak: u16) {
  let Ok(mut slot) = METER.lock() else { return };
  let Some(meter) = slot.as_mut() else { return };
  meter.blocks += 1;
  meter.pending = meter.pending.max(peak);
  meter.peak = meter.peak.max(peak);
  if meter.blocks.is_multiple_of(METER_BLOCKS) {
    let _ = meter.channel.send(dbfs_value(meter.pending));
    meter.pending = 0;
  }
}

/// harmony_stream_audio's log records, into stream-audio.log.
struct CrateLogger;

impl log::Log for CrateLogger {
  fn enabled(&self, metadata: &log::Metadata) -> bool {
    metadata.target().starts_with("harmony_stream_audio")
  }
  fn log(&self, record: &log::Record) {
    if self.enabled(record.metadata()) {
      trace(&format!("{} {}", record.level(), record.args()));
    }
  }
  fn flush(&self) {}
}

static CRATE_LOGGER: CrateLogger = CrateLogger;
/// None until opened, and when the log directory is unwritable.
static TRACE: Mutex<Option<File>> = Mutex::new(None);

fn open_trace(app: &AppHandle) {
  let Ok(mut slot) = TRACE.lock() else { return };
  if slot.is_some() {
    return;
  }
  let Ok(dir) = app.path().app_log_dir() else { return };
  if std::fs::create_dir_all(&dir).is_err() {
    return;
  }
  let path = dir.join(TRACE_FILE);
  let restart = std::fs::metadata(&path).is_ok_and(|m| m.len() > TRACE_MAX_BYTES);
  let mut options = OpenOptions::new();
  if restart {
    options.write(true).create(true).truncate(true);
  } else {
    options.append(true).create(true);
  }
  let Ok(mut file) = options.open(&path) else { return };
  let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
  let _ = writeln!(
    file,
    "-- session {now} (unix s), Harmony {}, {}",
    app.package_info().version,
    audio::os_version().unwrap_or_else(|| std::env::consts::OS.to_string())
  );
  *slot = Some(file);
  // The app installs no other logger; set_logger fails harmlessly if one exists.
  if log::set_logger(&CRATE_LOGGER).is_ok() {
    log::set_max_level(log::LevelFilter::Debug);
  }
}

/// One line, stamped with UTC time of day.
fn trace(line: &str) {
  log::info!("stream audio: {line}");
  let Ok(mut slot) = TRACE.lock() else { return };
  let Some(file) = slot.as_mut() else { return };
  let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
  let day_ms = ms % 86_400_000;
  let _ = writeln!(
    file,
    "{:02}:{:02}:{:02}.{:03}Z {line}",
    day_ms / 3_600_000,
    day_ms / 60_000 % 60,
    day_ms / 1000 % 60,
    day_ms % 1000
  );
}

fn permission_text() -> &'static str {
  match audio::permission_granted() {
    Some(true) => "granted",
    Some(false) => "not granted",
    None => "n/a",
  }
}

/// Peak of |sample| as dBFS, s16 full scale.
fn dbfs(peak: u16) -> String {
  if peak == 0 {
    "-inf".into()
  } else {
    format!("{:.1}", dbfs_value(peak))
  }
}

/// SILENCE_DBFS for a zero peak.
fn dbfs_value(peak: u16) -> f32 {
  if peak == 0 {
    SILENCE_DBFS
  } else {
    (20.0 * (peak as f64 / i16::MAX as f64).log10()) as f32
  }
}

/// Output of a short system command, stdout then stderr, trimmed. None when it cannot run.
fn command_output(program: &str, args: &[&str]) -> Option<(bool, String)> {
  let out = std::process::Command::new(program).args(args).output().ok()?;
  let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
  text.push_str(&String::from_utf8_lossy(&out.stderr));
  Some((out.status.success(), text.trim().to_string()))
}

/// macOS: how this app bundle is signed, from `codesign -dvvv`: the leaf authority or "ad-hoc",
/// and the CDHash. TCC keys an ad-hoc grant to the CDHash, which every build changes.
fn signing() -> Option<String> {
  if !cfg!(target_os = "macos") {
    return None;
  }
  let exe = std::env::current_exe().ok()?;
  let bundle = exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app"))?;
  let (_, text) = command_output("/usr/bin/codesign", &["-dvvv", &bundle.to_string_lossy()])?;
  let field = |key: &str| text.lines().find_map(|l| l.strip_prefix(key)).map(str::trim);
  let identity = if field("Signature=").is_some_and(|v| v == "adhoc") {
    "ad-hoc".to_string()
  } else {
    field("Authority=").map_or_else(|| "unsigned".to_string(), |a| format!("\"{a}\""))
  };
  Some(match field("CDHash=") {
    Some(cdhash) => format!("{identity}, cdhash {cdhash}"),
    None => identity,
  })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamAudioSupport {
  supported: bool,
  reason: Option<String>,
}

#[tauri::command]
pub fn stream_audio_support(app: AppHandle) -> StreamAudioSupport {
  open_trace(&app);
  let result = match audio::support() {
    Ok(()) => StreamAudioSupport { supported: true, reason: None },
    Err(e) => StreamAudioSupport { supported: false, reason: Some(e.to_string()) },
  };
  trace(&format!(
    "support: {}; screen recording {}",
    result.reason.as_deref().unwrap_or("ok"),
    permission_text()
  ));
  result
}

/// stream-audio.log as text, for the Go-live panel's copy action; at most the last
/// TRACE_MAX_BYTES. A system description heads it so a pasted log stands alone: version, OS,
/// signature, the Screen Recording preflight.
#[tauri::command]
pub async fn stream_audio_log(app: AppHandle) -> Result<String, String> {
  open_trace(&app);
  tauri::async_runtime::spawn_blocking(move || {
    if let Ok(mut slot) = TRACE.lock() {
      if let Some(file) = slot.as_mut() {
        let _ = file.flush();
      }
    }
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let path = dir.join(TRACE_FILE);
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let start = bytes.len().saturating_sub(TRACE_MAX_BYTES as usize);
    let body = String::from_utf8_lossy(&bytes[start..]);
    let mut header = format!(
      "Harmony {} ({}) on {} {}\nlog: {}\nscreen recording permission (preflight): {}",
      app.package_info().version,
      app.config().identifier,
      audio::os_version().unwrap_or_else(|| std::env::consts::OS.to_string()),
      std::env::consts::ARCH,
      path.display(),
      permission_text(),
    );
    if let Some(signing) = signing() {
      header.push_str(&format!("\nsigned: {signing}"));
    }
    Ok(format!("{header}\n{}\n{body}", "-".repeat(40)))
  })
  .await
  .map_err(|e| e.to_string())?
}

/// A line from the webview for stream-audio.log.
#[tauri::command]
pub fn stream_audio_trace(app: AppHandle, line: String) {
  open_trace(&app);
  let line: String = line.chars().take(TRACE_MAX_LINE).collect();
  trace(&format!("js {line}"));
}

/// The shared video track's label and displaySurface.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedSurface {
  label: String,
  display_surface: String,
}

impl SharedSurface {
  fn target(self) -> audio::Target {
    audio::Target::from_surface(&audio::SharedSurface { label: self.label, display_surface: self.display_surface })
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamAudioStarted {
  sample_rate: u32,
  channels: usize,
  block_frames: usize,
  #[serde(flatten)]
  source: Source,
  /// Passed back to stream_audio_stop, which then stops only this capture.
  session: u64,
}

/// The running capture; with `session`, only when it is that session's. Dropped by the caller,
/// outside the lock.
fn take_capture(session: Option<u64>) -> Option<Running> {
  let mut slot = CAPTURE.lock().ok()?;
  match (slot.as_ref(), session) {
    (Some(running), Some(wanted)) if running.session != wanted => None,
    _ => slot.take(),
  }
}

/// Cuts capture output into BLOCK_FRAMES blocks: to `on_audio` when given, to a test's meter, and
/// a level line in the log every REPORT_BLOCKS.
fn block_sink(on_audio: Option<Channel<String>>) -> audio::Sink {
  let mut pending: Vec<i16> = Vec::with_capacity(BLOCK_FRAMES * audio::CHANNELS * 2);
  let mut bytes: Vec<u8> = Vec::with_capacity(BLOCK_FRAMES * audio::CHANNELS * 2);
  let mut blocks: u64 = 0;
  let mut peak: u16 = 0;
  let verb = if on_audio.is_some() { "sent" } else { "metered" };
  Box::new(move |samples: &[i16]| {
    pending.extend_from_slice(samples);
    let block = BLOCK_FRAMES * audio::CHANNELS;
    let mut offset = 0;
    while pending.len() - offset >= block {
      let frame = &pending[offset..offset + block];
      let block_peak = frame.iter().fold(0u16, |p, s| p.max(s.unsigned_abs()));
      peak = peak.max(block_peak);
      if let Some(channel) = &on_audio {
        bytes.clear();
        for s in frame {
          bytes.extend_from_slice(&s.to_le_bytes());
        }
        // A closed webview fails the send; the capture runs until stopped.
        let _ = channel.send(base64::engine::general_purpose::STANDARD.encode(&bytes));
      }
      meter_block(block_peak);
      offset += block;
      blocks += 1;
      if blocks == 1 || blocks.is_multiple_of(REPORT_BLOCKS) {
        trace(&format!("audio: {blocks} blocks {verb}, peak {} dBFS", dbfs(peak)));
        peak = 0;
      }
    }
    pending.drain(..offset);
  })
}

/// Starts capturing `target` in place of any running capture. Errors read "unsupported: …",
/// "permission: …" or "failed: …".
fn start_capture(target: audio::Target, on_audio: Option<Channel<String>>) -> Result<(u64, Source), String> {
  drop(take_capture(None));
  trace(&format!("start: {target:?}; screen recording {}", permission_text()));
  let (capture, started) = audio::start(target, block_sink(on_audio)).map_err(|e| {
    trace(&format!("start failed: {e}"));
    e.to_string()
  })?;
  trace(&format!("started: {}", started.detail));
  let session = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
  let source = Source::from(started);
  if let Ok(mut slot) = CAPTURE.lock() {
    *slot = Some(Running { session, source: source.clone(), _capture: capture });
  }
  Ok((session, source))
}

/// Replaces any running capture.
#[tauri::command]
pub async fn stream_audio_start(
  app: AppHandle,
  surface: SharedSurface,
  on_audio: Channel<String>,
) -> Result<StreamAudioStarted, String> {
  open_trace(&app);
  tauri::async_runtime::spawn_blocking(move || {
    let (session, source) = start_capture(surface.target(), Some(on_audio))?;
    Ok(StreamAudioStarted {
      sample_rate: audio::SAMPLE_RATE,
      channels: audio::CHANNELS,
      block_frames: BLOCK_FRAMES,
      source,
      session,
    })
  })
  .await
  .map_err(|e| format!("failed: {e}"))?
}

#[tauri::command]
pub async fn stream_audio_stop(session: Option<u64>) {
  // Dropping a capture joins its thread (Windows) or waits for the stream to stop (macOS).
  let _ = tauri::async_runtime::spawn_blocking(move || {
    if take_capture(session).is_some() {
      trace(&format!("stopped session {}", session.map_or("any".into(), |s| s.to_string())));
    }
  })
  .await;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamAudioTest {
  /// The test metered a capture already running for a stream.
  live: bool,
  #[serde(flatten)]
  source: Source,
  /// BLOCK_FRAMES blocks that arrived.
  blocks: u64,
  /// Highest block peak, dBFS; SILENCE_DBFS for digital silence or no blocks.
  peak_dbfs: f32,
}

/// Meters capture for `seconds` (1 to 15, default 5): the running capture when a stream has
/// one, else a capture of `surface`, or of every app but this one without it, stopped after.
/// `on_level` receives the peak of every METER_BLOCKS blocks, dBFS.
#[tauri::command]
pub async fn stream_audio_test(
  app: AppHandle,
  surface: Option<SharedSurface>,
  seconds: Option<u64>,
  on_level: Channel<f32>,
) -> Result<StreamAudioTest, String> {
  open_trace(&app);
  tauri::async_runtime::spawn_blocking(move || {
    let seconds = seconds.unwrap_or(5).clamp(1, 15);
    if let Ok(mut slot) = METER.lock() {
      *slot = Some(Meter { channel: on_level, pending: 0, peak: 0, blocks: 0 });
    }
    let running = CAPTURE.lock().ok().and_then(|slot| slot.as_ref().map(|r| r.source.clone()));
    let (live, session, source) = match running {
      Some(source) => (true, None, source),
      None => {
        let target = surface.map_or(audio::Target::System, SharedSurface::target);
        match start_capture(target, None) {
          Ok((session, source)) => (false, Some(session), source),
          Err(e) => {
            if let Ok(mut slot) = METER.lock() {
              *slot = None;
            }
            trace(&format!("test: {e}"));
            return Err(e);
          }
        }
      }
    };
    trace(&format!("test: {seconds} s of {}, {}", if live { "the stream's capture" } else { "a test capture" }, source.detail));
    std::thread::sleep(Duration::from_secs(seconds));
    let meter = METER.lock().ok().and_then(|mut slot| slot.take());
    if let Some(session) = session {
      drop(take_capture(Some(session)));
    }
    let (blocks, peak) = meter.map_or((0, 0), |m| (m.blocks, m.peak));
    trace(&format!("test: {blocks} blocks, peak {} dBFS", dbfs(peak)));
    Ok(StreamAudioTest { live, source, blocks, peak_dbfs: dbfs_value(peak) })
  })
  .await
  .map_err(|e| format!("failed: {e}"))?
}

/// macOS: forgets this app's Screen Recording decision (`tccutil reset ScreenCapture <bundle
/// id>`; an app may reset its own entry without admin rights), so the next capture asks again.
/// System Settings can show Harmony allowed while TCC denies the running build: an ad-hoc grant
/// holds only for the CDHash it was given to.
#[tauri::command]
pub async fn stream_audio_reset_permission(app: AppHandle) -> Result<(), String> {
  open_trace(&app);
  if !cfg!(target_os = "macos") {
    return Err("unsupported: only macOS asks for Screen Recording".into());
  }
  let id = app.config().identifier.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let (ok, text) = command_output("/usr/bin/tccutil", &["reset", "ScreenCapture", &id])
      .ok_or_else(|| "failed: tccutil did not run".to_string())?;
    trace(&format!("permission reset for {id}: {}", if text.is_empty() { "ok" } else { text.as_str() }));
    if ok {
      Ok(())
    } else {
      Err(format!("failed: tccutil: {text}"))
    }
  })
  .await
  .map_err(|e| format!("failed: {e}"))?
}

/// macOS: opens System Settings at Screen & System Audio Recording.
#[tauri::command]
pub async fn stream_audio_open_settings() -> Result<(), String> {
  if !cfg!(target_os = "macos") {
    return Err("unsupported: only macOS asks for Screen Recording".into());
  }
  match command_output("/usr/bin/open", &[SCREEN_RECORDING_SETTINGS]) {
    Some((true, _)) => Ok(()),
    Some((false, text)) => Err(format!("failed: open: {text}")),
    None => Err("failed: open did not run".into()),
  }
}
