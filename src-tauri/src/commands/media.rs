// Runs `f` against the ndk_context context: the Application under tao 0.37
// (HarmonyApplication), which carries the methods called here by name. A Java
// exception left pending when the attach guard detaches the thread reaches the
// thread's uncaught-exception handler and kills the process; it is cleared and
// reported as an Err instead.
#[cfg(target_os = "android")]
fn with_app_context<T>(
  f: impl for<'a> FnOnce(&mut jni::JNIEnv<'a>, &jni::objects::JObject<'a>) -> jni::errors::Result<T>,
) -> Result<T, String> {
  let ctx = ndk_context::android_context();
  let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
  let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
  let context = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };
  let result = f(&mut env, &context);
  if env.exception_check().unwrap_or(false) {
    let _ = env.exception_describe();
    let _ = env.exception_clear();
  }
  result.map_err(|e| e.to_string())
}

// Native video thumbnail (MediaMetadataRetriever) — Android WebView can't decode a
// detached <video> for a canvas poster, and works for remote URLs without CORS.
#[tauri::command]
pub async fn android_video_thumbnail(url: String) -> Result<String, String> {
  #[cfg(target_os = "android")]
  {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
      use jni::objects::{JString, JValue};
      with_app_context(|env, context| {
        let jurl = env.new_string(&url)?;
        let result = env
          .call_method(
            context,
            "videoThumbnail",
            "(Ljava/lang/String;)Ljava/lang/String;",
            &[JValue::Object(&jurl)],
          )?
          .l()?;
        let s: String = env.get_string(&JString::from(result))?.into();
        Ok(s)
      })
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
// tauri-plugin-opener. Only http(s) URLs: an ACTION_VIEW intent for file:,
// content: or app schemes reaches other apps.
#[tauri::command]
pub fn android_open_url(url: String) -> Result<(), String> {
  if !is_web_url(&url) {
    return Err("only http and https URLs are opened".into());
  }
  #[cfg(target_os = "android")]
  {
    use jni::objects::JValue;
    with_app_context(|env, context| {
      let jurl = env.new_string(&url)?;
      env.call_method(context, "openUrl", "(Ljava/lang/String;)V", &[JValue::Object(&jurl)])?;
      Ok(())
    })?;
  }
  #[cfg(not(target_os = "android"))]
  let _ = url;
  Ok(())
}

fn is_web_url(url: &str) -> bool {
  let lower = url.to_ascii_lowercase();
  let rest = if let Some(r) = lower.strip_prefix("https://") {
    r
  } else if let Some(r) = lower.strip_prefix("http://") {
    r
  } else {
    return false;
  };
  !rest.is_empty() && !url.chars().any(|c| c.is_control())
}

#[cfg(test)]
mod tests {
  use super::is_web_url;

  #[test]
  fn web_url_schemes() {
    assert!(is_web_url("https://example.com/a"));
    assert!(is_web_url("HTTP://example.com"));
    assert!(!is_web_url("javascript:alert(1)"));
    assert!(!is_web_url("intent://x#Intent;scheme=http;end"));
    assert!(!is_web_url("file:///data/data/online.knowmad.harmony/x"));
    assert!(!is_web_url("content://media/external/x"));
    assert!(!is_web_url("https://"));
    assert!(!is_web_url(" https://example.com"));
    assert!(!is_web_url("https://a\nb"));
  }
}

// start/stop the Android call foreground service (keeps audio alive when backgrounded)
#[tauri::command]
pub fn android_call_service(start: bool) -> Result<(), String> {
  #[cfg(target_os = "android")]
  {
    let method = if start { "startCallService" } else { "stopCallService" };
    with_app_context(|env, context| {
      env.call_method(context, method, "()V", &[])?;
      Ok(())
    })?;
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
    use jni::objects::JValue;
    with_app_context(|env, context| {
      let jstatus = env.new_string(&status_hex)?;
      let jnav = env.new_string(&nav_hex)?;
      env.call_method(
        context,
        "setSystemBarColors",
        "(Ljava/lang/String;Ljava/lang/String;ZZ)V",
        &[
          JValue::Object(&jstatus),
          JValue::Object(&jnav),
          JValue::Bool(status_dark as u8),
          JValue::Bool(nav_dark as u8),
        ],
      )?;
      Ok(())
    })?;
  }
  #[cfg(not(target_os = "android"))]
  let _ = (status_hex, nav_hex, status_dark, nav_dark);
  Ok(())
}
