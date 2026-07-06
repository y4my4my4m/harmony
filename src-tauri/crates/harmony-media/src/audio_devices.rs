//! pactl-based device control: webrtc's Linux ADM returns empty GUIDs, so its
//! guid setter always falls back to device 0.

use std::process::Command;

use serde::Deserialize;

use crate::engine::DeviceInfo;

fn pactl_json(args: &[&str]) -> Result<serde_json::Value, String> {
  let output = Command::new("pactl")
    .arg("-f")
    .arg("json")
    .args(args)
    .output()
    .map_err(|e| format!("pactl: {e}"))?;
  if !output.status.success() {
    return Err(format!("pactl {args:?} failed"));
  }
  serde_json::from_slice(&output.stdout).map_err(|e| format!("pactl parse: {e}"))
}

#[derive(Deserialize)]
struct PulseDevice {
  name: String,
  description: String,
}

pub fn list_outputs() -> Vec<DeviceInfo> {
  pactl_json(&["list", "sinks"])
    .and_then(|v| serde_json::from_value::<Vec<PulseDevice>>(v).map_err(|e| e.to_string()))
    .map(|devices| {
      devices
        .into_iter()
        .map(|d| DeviceInfo { id: d.name, label: d.description })
        .collect()
    })
    .unwrap_or_default()
}

pub fn list_inputs() -> Vec<DeviceInfo> {
  pactl_json(&["list", "sources"])
    .and_then(|v| serde_json::from_value::<Vec<PulseDevice>>(v).map_err(|e| e.to_string()))
    .map(|devices| {
      devices
        .into_iter()
        // monitors are sink loopbacks, not microphones
        .filter(|d| !d.name.ends_with(".monitor"))
        .map(|d| DeviceInfo { id: d.name, label: d.description })
        .collect()
    })
    .unwrap_or_default()
}

fn own_stream_indexes(kind: &str) -> Vec<u64> {
  let pid = std::process::id().to_string();
  let Ok(value) = pactl_json(&["list", kind]) else { return vec![] };
  let Some(entries) = value.as_array() else { return vec![] };
  entries
    .iter()
    .filter(|e| {
      e.get("properties")
        .and_then(|p| p.get("application.process.id"))
        .and_then(|v| v.as_str())
        == Some(pid.as_str())
    })
    .filter_map(|e| e.get("index").and_then(|v| v.as_u64()))
    .collect()
}

// only moves streams that exist now; re-call after playout starts
pub fn move_playback_to(sink: &str) -> Result<(), String> {
  for index in own_stream_indexes("sink-inputs") {
    let _ = Command::new("pactl")
      .args(["move-sink-input", &index.to_string(), sink])
      .status()
      .map_err(|e| e.to_string())?;
  }
  Ok(())
}

pub fn move_recording_to(source: &str) -> Result<(), String> {
  for index in own_stream_indexes("source-outputs") {
    let _ = Command::new("pactl")
      .args(["move-source-output", &index.to_string(), source])
      .status()
      .map_err(|e| e.to_string())?;
  }
  Ok(())
}
