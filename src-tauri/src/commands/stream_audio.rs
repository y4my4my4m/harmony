//! Screen-share program audio for the webview (harmony-stream-audio). Captured PCM goes out in
//! 20 ms blocks of interleaved s16le stereo at 48 kHz, base64 encoded: a JSON channel message
//! under tauri's 8 KiB direct-execute threshold is evaluated in send order, while raw payloads
//! over 1 KiB are fetched asynchronously and can arrive reordered.

use std::sync::Mutex;

use base64::Engine;
use harmony_stream_audio as audio;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

/// 20 ms at 48 kHz: 3840 bytes, 5120 base64 characters.
const BLOCK_FRAMES: usize = 960;

static CAPTURE: Mutex<Option<audio::Capture>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamAudioSupport {
  supported: bool,
  reason: Option<String>,
}

#[tauri::command]
pub fn stream_audio_support() -> StreamAudioSupport {
  match audio::support() {
    Ok(()) => StreamAudioSupport { supported: true, reason: None },
    Err(e) => StreamAudioSupport { supported: false, reason: Some(e.to_string()) },
  }
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
pub async fn stream_audio_start(surface: SharedSurface, on_audio: Channel<String>) -> Result<StreamAudioStarted, String> {
  tauri::async_runtime::spawn_blocking(move || {
    drop(take_capture());
    let target = audio::Target::from_surface(&audio::SharedSurface {
      label: surface.label,
      display_surface: surface.display_surface,
    });
    let mut pending: Vec<i16> = Vec::with_capacity(BLOCK_FRAMES * audio::CHANNELS * 2);
    let mut bytes: Vec<u8> = Vec::with_capacity(BLOCK_FRAMES * audio::CHANNELS * 2);
    let sink: audio::Sink = Box::new(move |samples: &[i16]| {
      pending.extend_from_slice(samples);
      let block = BLOCK_FRAMES * audio::CHANNELS;
      let mut offset = 0;
      while pending.len() - offset >= block {
        bytes.clear();
        for s in &pending[offset..offset + block] {
          bytes.extend_from_slice(&s.to_le_bytes());
        }
        // A closed webview fails the send; the capture runs until stopped.
        let _ = on_audio.send(base64::engine::general_purpose::STANDARD.encode(&bytes));
        offset += block;
      }
      pending.drain(..offset);
    });
    let (capture, started) = audio::start(target, sink).map_err(|e| e.to_string())?;
    log::info!("stream audio: {}", started.detail);
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
  let _ = tauri::async_runtime::spawn_blocking(|| drop(take_capture())).await;
}
