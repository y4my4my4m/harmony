#[cfg(all(feature = "native-media", target_os = "linux"))]
pub use native::*;

#[tauri::command]
pub fn native_media_supported() -> bool {
  cfg!(all(feature = "native-media", target_os = "linux"))
}

// native Android notification with a downloaded avatar (large icon); the
// notification plugin can only use bundled drawables, so it can't show avatars
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn show_android_notification(
  id: i32,
  sender: String,
  conversation_title: String,
  message: String,
  avatar_url: String,
  group_key: String,
) -> Result<(), String> {
  #[cfg(target_os = "android")]
  {
    use jni::objects::{JObject, JValue};
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
    let jsender = env.new_string(&sender).map_err(|e| e.to_string())?;
    let jtitle = env.new_string(&conversation_title).map_err(|e| e.to_string())?;
    let jmsg = env.new_string(&message).map_err(|e| e.to_string())?;
    let javatar = env.new_string(&avatar_url).map_err(|e| e.to_string())?;
    let jgroup = env.new_string(&group_key).map_err(|e| e.to_string())?;
    env
      .call_method(
        activity,
        "showNotification",
        "(ILjava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
        &[
          JValue::Int(id),
          JValue::Object(&jsender),
          JValue::Object(&jtitle),
          JValue::Object(&jmsg),
          JValue::Object(&javatar),
          JValue::Object(&jgroup),
        ],
      )
      .map_err(|e| e.to_string())?;
  }
  #[cfg(not(target_os = "android"))]
  let _ = (id, sender, conversation_title, message, avatar_url, group_key);
  Ok(())
}

// #RRGGBB status/nav backgrounds; *_dark = dark icons on that bar (for a light bg)
#[tauri::command]
pub fn set_system_bar_colors(
  status_hex: String,
  nav_hex: String,
  status_dark: bool,
  nav_dark: bool,
) -> Result<(), String> {
  #[cfg(target_os = "android")]
  {
    use jni::objects::{JObject, JValue};
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
    let jstatus = env.new_string(&status_hex).map_err(|e| e.to_string())?;
    let jnav = env.new_string(&nav_hex).map_err(|e| e.to_string())?;
    env
      .call_method(
        activity,
        "setSystemBarColors",
        "(Ljava/lang/String;Ljava/lang/String;ZZ)V",
        &[
          JValue::Object(&jstatus),
          JValue::Object(&jnav),
          JValue::Bool(status_dark as u8),
          JValue::Bool(nav_dark as u8),
        ],
      )
      .map_err(|e| e.to_string())?;
  }
  #[cfg(not(target_os = "android"))]
  let _ = (status_hex, nav_hex, status_dark, nav_dark);
  Ok(())
}

#[cfg(all(feature = "native-media", target_os = "linux"))]
mod native {
  use std::sync::Arc;

  use harmony_media::{
    DeviceList, EngineSnapshot, MediaEngine, MediaEvent, ScreenSource, VolumeSource,
  };
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
    source: Option<ScreenSource>,
  ) -> Result<bool, String> {
    state.0.set_screenshare(enabled, fps, source).await
  }

  #[tauri::command]
  pub async fn media_set_video_device(
    state: State<'_, MediaState>,
    device_id: String,
  ) -> Result<(), String> {
    state.0.set_video_device(device_id).await
  }

  #[tauri::command]
  pub async fn media_list_screen_sources(
    state: State<'_, MediaState>,
  ) -> Result<Vec<ScreenSource>, String> {
    state.0.list_screen_sources().await
  }

  #[tauri::command]
  pub async fn media_screen_thumbnail(source: ScreenSource) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || harmony_media::capture_thumbnail(source))
      .await
      .map_err(|e| e.to_string())
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
