//! Android push for Harmony. The Kotlin side receives FCM and UnifiedPush messages, renders
//! and cancels notifications, and routes taps into the app; see android/.
//!
//! Registering the plugin is all Rust does: the webview invokes the Kotlin commands directly.

use tauri::{
  plugin::{Builder, TauriPlugin},
  Runtime,
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "online.knowmad.harmony.push";

pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("harmony-push")
    .setup(|_app, _api| {
      #[cfg(target_os = "android")]
      _api.register_android_plugin(PLUGIN_IDENTIFIER, "PushPlugin")?;
      Ok(())
    })
    .build()
}
