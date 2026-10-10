//! Screen-share program audio for the webview (harmony-stream-audio). Captured PCM goes out in
//! 20 ms blocks of interleaved s16le stereo at 48 kHz, base64 encoded: a JSON channel message
//! under tauri's 8 KiB direct-execute threshold is evaluated in send order, while raw payloads
//! over 1 KiB are fetched asynchronously and can arrive reordered.
//!
//! Events go to <app log dir>/stream-audio.log (macOS ~/Library/Logs/online.knowmad.harmony,
//! Windows %LOCALAPPDATA%\online.knowmad.harmony\logs): release builds keep no other log.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

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

static CAPTURE: Mutex<Option<audio::Capture>> = Mutex::new(None);
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
  let _ = writeln!(file, "-- session {now} (unix s), Harmony {}", app.package_info().version);
  *slot = Some(file);
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
    format!("{:.1}", 20.0 * (peak as f64 / i16::MAX as f64).log10())
  }
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamAudioStarted {
  sample_rate: u32,
  channels: usize,
  block_frames: usize,
  /// "system" or "app".
  scope: &'static str,
  app: Option<String>,
  detail: String,
}

fn take_capture() -> Option<audio::Capture> {
  CAPTURE.lock().ok().and_then(|mut c| c.take())
}

/// Replaces any running capture. Errors read "unsupported: …", "permission: …" or "failed: …".
#[tauri::command]
pub async fn stream_audio_start(
  app: AppHandle,
  surface: SharedSurface,
  on_audio: Channel<String>,
) -> Result<StreamAudioStarted, String> {
  open_trace(&app);
  tauri::async_runtime::spawn_blocking(move || {
    drop(take_capture());
    let target = audio::Target::from_surface(&audio::SharedSurface {
      label: surface.label,
      display_surface: surface.display_surface,
    });
    trace(&format!("start: {target:?}; screen recording {}", permission_text()));
    let mut pending: Vec<i16> = Vec::with_capacity(BLOCK_FRAMES * audio::CHANNELS * 2);
    let mut bytes: Vec<u8> = Vec::with_capacity(BLOCK_FRAMES * audio::CHANNELS * 2);
    let mut blocks: u64 = 0;
    let mut peak: u16 = 0;
    let sink: audio::Sink = Box::new(move |samples: &[i16]| {
      pending.extend_from_slice(samples);
      let block = BLOCK_FRAMES * audio::CHANNELS;
      let mut offset = 0;
      while pending.len() - offset >= block {
        bytes.clear();
        for s in &pending[offset..offset + block] {
          peak = peak.max(s.unsigned_abs());
          bytes.extend_from_slice(&s.to_le_bytes());
        }
        // A closed webview fails the send; the capture runs until stopped.
        let _ = on_audio.send(base64::engine::general_purpose::STANDARD.encode(&bytes));
        offset += block;
        blocks += 1;
        if blocks == 1 || blocks.is_multiple_of(REPORT_BLOCKS) {
          trace(&format!("audio: {blocks} blocks sent, peak {} dBFS", dbfs(peak)));
          peak = 0;
        }
      }
      pending.drain(..offset);
    });
    let (capture, started) = audio::start(target, sink).map_err(|e| {
      trace(&format!("start failed: {e}"));
      e.to_string()
    })?;
    trace(&format!("started: {}", started.detail));
    if let Ok(mut slot) = CAPTURE.lock() {
      *slot = Some(capture);
    }
    Ok(StreamAudioStarted {
      sample_rate: audio::SAMPLE_RATE,
      channels: audio::CHANNELS,
      block_frames: BLOCK_FRAMES,
      scope: match started.scope {
        audio::Scope::System => "system",
        audio::Scope::App => "app",
      },
      app: started.app,
      detail: started.detail,
    })
  })
  .await
  .map_err(|e| format!("failed: {e}"))?
}

#[tauri::command]
pub async fn stream_audio_stop() {
  // Dropping a capture joins its thread (Windows) or waits for the stream to stop (macOS).
  let _ = tauri::async_runtime::spawn_blocking(|| {
    if take_capture().is_some() {
      trace("stopped");
    }
  })
  .await;
}
