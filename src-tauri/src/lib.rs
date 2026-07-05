#[cfg(all(feature = "native-media", target_os = "linux"))]
mod call_window;
mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default()
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      #[cfg(all(feature = "native-media", target_os = "linux"))]
      commands::media::init(&app.handle().clone());
      let _ = app;
      Ok(())
    });

  #[cfg(all(feature = "native-media", target_os = "linux"))]
  let builder = builder.invoke_handler(tauri::generate_handler![
    commands::media::native_media_supported,
    commands::media::media_connect,
    commands::media::media_disconnect,
    commands::media::media_get_state,
    commands::media::media_set_muted,
    commands::media::media_set_deafened,
    commands::media::media_list_devices,
    commands::media::media_set_input_device,
    commands::media::media_set_output_device,
    commands::media::media_set_user_volume,
    commands::media::media_broadcast,
    commands::media::media_enable_camera,
    commands::media::media_set_screenshare,
    commands::media::media_set_video_device,
    commands::media::media_list_screen_sources,
    commands::media::media_screen_thumbnail,
    commands::media::call_window_open,
    commands::media::call_window_close,
    commands::media::set_system_bar_colors
  ]);
  #[cfg(not(all(feature = "native-media", target_os = "linux")))]
  let builder = builder.invoke_handler(tauri::generate_handler![
    commands::media::native_media_supported,
    commands::media::set_system_bar_colors
  ]);

  builder
    .run(tauri::generate_context!())
    .expect("error running tauri");
}
