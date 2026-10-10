mod commands;
#[cfg(desktop)]
mod overlay;
#[cfg(target_os = "linux")]
mod runtime;
#[cfg(desktop)]
mod updater;

#[cfg(desktop)]
fn setup_desktop(app: &tauri::AppHandle) -> tauri::Result<()> {
  use tauri::menu::{Menu, MenuItem};
  use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
  use tauri::Manager;

  let show = MenuItem::with_id(app, "show", "Show Harmony", true, None::<&str>)?;
  let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[&show, &quit])?;

  // The Linux tray is a StatusNotifierItem (ksni). Registration fails where no
  // StatusNotifierWatcher runs (GNOME without the AppIndicator extension); the
  // app then runs without a tray and closing the window quits.
  let tray = TrayIconBuilder::with_id("main")
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
    .build(app);
  let has_tray = match tray {
    Ok(_) => true,
    Err(e) => {
      eprintln!("[tray] unavailable: {e}");
      false
    }
  };

  // hotkey toggles overlay click-through <-> interactive (non-fatal if it fails)
  {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    if let Err(e) = app.global_shortcut().on_shortcut("CmdOrCtrl+Shift+O", |app, _shortcut, event| {
      if event.state() == ShortcutState::Pressed {
        crate::overlay::toggle_interactive(app);
      }
    }) {
      eprintln!("[overlay] failed to register hotkey: {e}");
    }
  }

  // X on the main window minimizes to tray instead of quitting (Discord-style)
  if let Some(win) = app.get_webview_window("main") {
    if has_tray {
      let w = win.clone();
      win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
          api.prevent_close();
          let _ = w.hide();
        }
      });
    }
    // autostart with --minimized launches hidden to tray
    if has_tray && std::env::args().any(|a| a == "--minimized") {
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
  let context = tauri::generate_context!();

  #[cfg(target_os = "linux")]
  if runtime::hand_off_to_running_instance(&context.config().identifier) {
    return;
  }

  let builder = tauri::Builder::default();

  #[cfg(target_os = "linux")]
  let builder = builder
    .runtime(runtime::cef())
    .on_page_load(runtime::on_page_load)
    .on_permission_request(runtime::on_permission_request);
  #[cfg(not(target_os = "linux"))]
  let builder = builder.runtime(tauri_runtime_wry::Wry::default());

  #[cfg(desktop)]
  let builder = builder
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      reveal_main(app);
    }))
    .plugin(tauri_plugin_autostart::init(
      tauri_plugin_autostart::MacosLauncher::LaunchAgent,
      Some(vec!["--minimized"]),
    ))
    .plugin(tauri_plugin_global_shortcut::Builder::new().build())
    .plugin(tauri_plugin_process::init());

  #[cfg(desktop)]
  let builder = {
    let status = updater::status(context.config());
    let builder = builder.manage(updater::UpdaterState(status));
    if status == updater::UpdaterStatus::Enabled {
      builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
      builder
    }
  };

  #[cfg(target_os = "android")]
  let builder = builder.plugin(tauri_plugin_harmony_push::init());

  let builder = builder
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_notification::init())
    .setup(|app| {
      #[cfg(desktop)]
      {
        use tauri::Manager;
        app.manage(commands::presence::PresenceState::default());
        app.manage(overlay::OverlayInteractive::default());
        setup_desktop(&app.handle().clone())?;
      }
      #[cfg(target_os = "linux")]
      {
        use tauri::Manager;
        if runtime::destroy_chromium_work_source() == 0 {
          eprintln!("[cef] no Chromium GLib work source to destroy");
        }
        if let Some(main) = app.get_webview_window("main") {
          runtime::allow_local_network(&main);
        }
      }
      let _ = app;
      Ok(())
    });

  #[cfg(desktop)]
  let builder = builder.invoke_handler(tauri::generate_handler![
    commands::media::set_system_bar_colors,
    commands::presence::presence_start,
    commands::presence::presence_stop,
    commands::presence::presence_current,
    commands::ptt::ptt_set_binding,
    commands::stream_audio::stream_audio_support,
    commands::stream_audio::stream_audio_start,
    commands::stream_audio::stream_audio_stop,
    commands::stream_audio::stream_audio_trace,
    overlay::overlay_open,
    overlay::overlay_close,
    overlay::overlay_set_interactive,
    updater::updater_status
  ]);
  // mobile (android/ios) — no desktop-only commands
  #[cfg(mobile)]
  let builder = builder.invoke_handler(tauri::generate_handler![
    commands::media::set_system_bar_colors,
    commands::media::android_call_service,
    commands::media::android_open_url,
    commands::media::android_video_thumbnail
  ]);

  if let Err(e) = builder.run(context) {
    // Linux: CEF also fails here when its process singleton handed the launch to a
    // running instance that the D-Bus hand-off above could not reach.
    eprintln!("Harmony failed to start: {e}");
    std::process::exit(1);
  }
}
