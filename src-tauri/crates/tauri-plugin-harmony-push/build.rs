// Commands are implemented by the Kotlin plugin; listed here for the ACL.
const COMMANDS: &[&str] = &[
  "status",
  "request_permission",
  "open_settings",
  "get_fcm_token",
  "show",
  "cancel",
  "take_launch_target",
  "unified_push_register",
  "unified_push_unregister",
  "register_listener",
  "remove_listener",
];

fn main() {
  tauri_plugin::Builder::new(COMMANDS)
    .android_path("android")
    .build();
}
