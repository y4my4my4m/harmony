#[cfg(all(feature = "native-media", target_os = "linux"))]
pub use native::*;

#[tauri::command]
pub fn native_media_supported() -> bool {
  cfg!(all(feature = "native-media", target_os = "linux"))
}

#[cfg(all(feature = "native-media", target_os = "linux"))]
mod native {
  use std::sync::Arc;

  use harmony_media::{DeviceList, EngineSnapshot, MediaEngine, MediaEvent, VolumeSource};
  use tauri::{AppHandle, Emitter, Manager, State};

  use crate::call_window;

  pub struct MediaState(pub MediaEngine);

  pub fn init(app: &AppHandle) {
    app.manage(call_window::CallWindowState::default());
    let handle = app.clone();
    let engine = MediaEngine::new(Arc::new(move |event: MediaEvent| {
      let (name, payload) = match &event {
        MediaEvent::Connected { .. } => ("media://connected", serde_json::to_value(&event)),
        MediaEvent::Disconnected { .. } => ("media://disconnected", serde_json::to_value(&event)),
        MediaEvent::UserJoined(_) => ("media://user-joined", serde_json::to_value(&event)),
        MediaEvent::UserLeft { .. } => ("media://user-left", serde_json::to_value(&event)),
        MediaEvent::UserState(_) => ("media://user-state", serde_json::to_value(&event)),
        MediaEvent::LocalState(_) => ("media://local-state", serde_json::to_value(&event)),
        MediaEvent::StateSynced { .. } => ("media://state-synced", serde_json::to_value(&event)),
        MediaEvent::AudioLevels { .. } => ("media://audio-levels", serde_json::to_value(&event)),
        MediaEvent::Data { .. } => ("media://data", serde_json::to_value(&event)),
        MediaEvent::ConnectionState { .. } => {
          ("media://connection-state", serde_json::to_value(&event))
        }
        MediaEvent::Error { .. } => ("media://error", serde_json::to_value(&event)),
      };
      if let Ok(payload) = payload {
        let _ = handle.emit(name, payload);
      }
    }));
    app.manage(MediaState(engine));
  }

  #[tauri::command]
  pub async fn media_connect(
    state: State<'_, MediaState>,
    ws_url: String,
    token: String,
    channel_id: String,
    user_id: String,
  ) -> Result<(), String> {
    state.0.connect(ws_url, token, channel_id, user_id).await
  }

  #[tauri::command]
  pub async fn media_disconnect(state: State<'_, MediaState>) -> Result<(), String> {
    state.0.disconnect().await
  }

  #[tauri::command]
  pub async fn media_get_state(state: State<'_, MediaState>) -> Result<EngineSnapshot, String> {
    state.0.get_state().await
  }

  #[tauri::command]
  pub async fn media_set_muted(state: State<'_, MediaState>, muted: bool) -> Result<bool, String> {
    state.0.set_muted(muted).await
  }

  #[tauri::command]
  pub async fn media_set_deafened(
    state: State<'_, MediaState>,
    deafened: bool,
  ) -> Result<bool, String> {
    state.0.set_deafened(deafened).await
  }

  #[tauri::command]
  pub async fn media_list_devices(state: State<'_, MediaState>) -> Result<DeviceList, String> {
    state.0.list_devices().await
  }

  #[tauri::command]
  pub async fn media_set_input_device(
    state: State<'_, MediaState>,
    device_id: String,
  ) -> Result<(), String> {
    state.0.set_input_device(device_id).await
  }

  #[tauri::command]
  pub async fn media_set_output_device(
    state: State<'_, MediaState>,
    device_id: String,
  ) -> Result<(), String> {
    state.0.set_output_device(device_id).await
  }

  #[tauri::command]
  pub async fn media_enable_camera(
    state: State<'_, MediaState>,
    enabled: bool,
  ) -> Result<bool, String> {
    state.0.enable_camera(enabled).await
  }

  #[tauri::command]
  pub async fn media_set_screenshare(
    state: State<'_, MediaState>,
    enabled: bool,
    fps: Option<u32>,
  ) -> Result<bool, String> {
    state.0.set_screenshare(enabled, fps).await
  }

  #[tauri::command]
  pub async fn call_window_open(
    app: AppHandle,
    state: State<'_, MediaState>,
  ) -> Result<(), String> {
    let frames = state.0.frames();
    call_window::open(&app, frames)
  }

  #[tauri::command]
  pub async fn call_window_close(app: AppHandle) -> Result<(), String> {
    call_window::close(&app);
    Ok(())
  }

  #[tauri::command]
  pub async fn media_broadcast(
    state: State<'_, MediaState>,
    payload: String,
    topic: Option<String>,
  ) -> Result<(), String> {
    state.0.broadcast(payload, topic).await
  }

  #[tauri::command]
  pub async fn media_set_user_volume(
    state: State<'_, MediaState>,
    user_id: String,
    source: VolumeSource,
    volume: u16,
  ) -> Result<(), String> {
    state.0.set_user_volume(user_id, source, volume).await
  }
}
