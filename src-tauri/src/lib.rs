#[cfg(all(feature = "native-media", target_os = "linux"))]
mod call_window;
mod commands;

#[cfg(desktop)]
fn setup_desktop(app: &tauri::AppHandle) -> tauri::Result<()> {
  use tauri::menu::{Menu, MenuItem};
  use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
  use tauri::Manager;

  let show = MenuItem::with_id(app, "show", "Show Harmony", true, None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[&show, &quit])?;

  TrayIconBuilder::with_id("main")
    .icon(app.default_window_icon().cloned().expect("no window icon"))
    .tooltip("Harmony")
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id.as_ref() {
      "show" => reveal_main(app),
      "quit" => app.exit(0),
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        let app = tray.app_handle();
        if let Some(w) = app.get_webview_window("main") {
          if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
          } else {
            reveal_main(app);
          }
        }
      }
    })
    .build(app)?;

  // X on the main window minimizes to tray instead of quitting (Discord-style)
  if let Some(win) = app.get_webview_window("main") {
    let w = win.clone();
    win.on_window_event(move |event| {
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = w.hide();
      }
    });
    // autostart with --minimized launches hidden to tray
    if std::env::args().any(|a| a == "--minimized") {
      let _ = win.hide();
    }
  }
  Ok(())
}

#[cfg(desktop)]
fn reveal_main(app: &tauri::AppHandle) {
  use tauri::Manager;
  if let Some(w) = app.get_webview_window("main") {
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default();

  #[cfg(desktop)]
  let builder = builder
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      reveal_main(app);
    }))
    .plugin(tauri_plugin_autostart::init(
      tauri_plugin_autostart::MacosLauncher::LaunchAgent,
      Some(vec!["--minimized"]),
    ));

  let builder = builder
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_notification::init())
    .setup(|app| {
      #[cfg(all(feature = "native-media", target_os = "linux"))]
      commands::media::init(&app.handle().clone());
      #[cfg(desktop)]
      setup_desktop(&app.handle().clone())?;
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
    commands::media::set_system_bar_colors,
    commands::media::show_android_notification
  ]);
  #[cfg(not(all(feature = "native-media", target_os = "linux")))]
  let builder = builder.invoke_handler(tauri::generate_handler![
    commands::media::native_media_supported,
    commands::media::set_system_bar_colors,
    commands::media::show_android_notification
  ]);

  builder
    .run(tauri::generate_context!())
    .expect("error running tauri");
}
