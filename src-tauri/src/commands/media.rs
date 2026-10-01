// Native video thumbnail (MediaMetadataRetriever) — Android WebView can't decode a
// detached <video> for a canvas poster, and works for remote URLs without CORS.
#[tauri::command]
pub async fn android_video_thumbnail(url: String) -> Result<String, String> {
  #[cfg(target_os = "android")]
  {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
      use jni::objects::{JObject, JValue};
      let ctx = ndk_context::android_context();
      let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
      let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
      let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
      let jurl = env.new_string(&url).map_err(|e| e.to_string())?;
      let result = env
        .call_method(
          activity,
          "videoThumbnail",
          "(Ljava/lang/String;)Ljava/lang/String;",
          &[JValue::Object(&jurl)],
        )
        .map_err(|e| e.to_string())?
        .l()
        .map_err(|e| e.to_string())?;
      let s: String = env
        .get_string(&result.into())
        .map_err(|e| e.to_string())?
        .into();
      Ok(s)
    })
    .await
    .map_err(|e| e.to_string())?
  }
  #[cfg(not(target_os = "android"))]
  {
    let _ = url;
    Ok(String::new())
  }
}

// Android opens URLs here, through an ACTION_VIEW intent, rather than through
// tauri-plugin-opener.
#[tauri::command]
pub fn android_open_url(url: String) -> Result<(), String> {
  #[cfg(target_os = "android")]
  {
    use jni::objects::{JObject, JValue};
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
    let jurl = env.new_string(&url).map_err(|e| e.to_string())?;
    env
      .call_method(
        activity,
        "openUrl",
        "(Ljava/lang/String;)V",
        &[JValue::Object(&jurl)],
      )
      .map_err(|e| e.to_string())?;
  }
  #[cfg(not(target_os = "android"))]
  let _ = url;
  Ok(())
}

// start/stop the Android call foreground service (keeps audio alive when backgrounded)
#[tauri::command]
pub fn android_call_service(start: bool) -> Result<(), String> {
  #[cfg(target_os = "android")]
  {
    use jni::objects::JObject;
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
    let method = if start { "startCallService" } else { "stopCallService" };
    env
      .call_method(activity, method, "()V", &[])
      .map_err(|e| e.to_string())?;
  }
  #[cfg(not(target_os = "android"))]
  let _ = start;
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
