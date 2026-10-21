#[cfg(any(target_os = "macos", target_os = "ios"))]
mod apple_navigation;
mod commands;
mod external_links;
#[cfg(desktop)]
mod float_dock;
#[cfg(target_os = "ios")]
mod ios;
#[cfg(desktop)]
mod overlay;
#[cfg(any(windows, target_os = "macos"))]
mod popout;
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

/// tauri.conf.json declares the main window with `create: false`: a new-window
/// handler can only be set while a webview is built (popout.rs).
fn build_main_window(app: &tauri::App) -> tauri::Result<()> {
  let Some(config) = app.config().app.windows.iter().find(|w| w.label == "main" && !w.create).cloned() else {
    return Ok(());
  };
  let builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?;
  let navigator = external_links::Navigator::default();
  let on_load = navigator.clone();
  let builder = builder.on_page_load(move |_window, payload| {
    if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
      on_load.on_page_started(payload.url());
    }
  });
  // WKWebView reports subframe loads to the navigation handler without their frame; Apple
  // judges navigations in its own delegate once the webview exists (apple_navigation.rs).
  #[cfg(not(any(target_os = "macos", target_os = "ios")))]
  let builder = {
    let handle = app.handle().clone();
    builder.on_navigation(move |url| external_links::navigate(&handle, &navigator, external_links::Frame::Main, url))
  };
  #[cfg(any(windows, target_os = "macos"))]
  let builder = {
    let handle = app.handle().clone();
    builder.on_new_window(move |url, features| popout::on_new_window(&handle, url, features))
  };
  // CEF opens window.open('about:blank') as its own popup, linked to the opener (the call
  // pop-out); a popup inherits the main window's navigation handler, which would cancel an
  // http(s) one and leave it empty, so that one opens outside instead.
  #[cfg(target_os = "linux")]
  let builder = {
    let handle = app.handle().clone();
    builder.on_new_window(move |url, _features| {
      if url.as_str() == "about:blank" {
        tauri::webview::NewWindowResponse::Allow
      } else {
        if matches!(url.scheme(), "http" | "https") {
          external_links::open_outside(&handle, &url);
        }
        tauri::webview::NewWindowResponse::Deny
      }
    })
  };
  #[cfg(not(any(target_os = "macos", target_os = "ios")))]
  builder.build()?;
  #[cfg(any(target_os = "macos", target_os = "ios"))]
  {
    let window = builder.build()?;
    let handle = app.handle().clone();
    apple_navigation::judge_navigations(&window, move |frame, url| {
      external_links::navigate(&handle, &navigator, frame, url)
    });
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
      build_main_window(app)?;
      #[cfg(desktop)]
      {
        use tauri::Manager;
        app.manage(commands::presence::PresenceState::default());
        app.manage(overlay::OverlayInteractive::default());
        setup_desktop(&app.handle().clone())?;
      }
      #[cfg(target_os = "ios")]
      {
        use tauri::Manager;
        if let Some(main) = app.get_webview_window("main") {
          ios::fill_safe_area(&main);
        }
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
    overlay::overlay_open,
    overlay::overlay_close,
    overlay::overlay_set_interactive,
    float_dock::float_dock_open,
    float_dock::float_dock_close,
    float_dock::float_dock_focus_main,
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

  let app = match builder.build(context) {
    Ok(app) => app,
    Err(e) => {
      // Linux: CEF also fails here when its process singleton handed the launch to a
      // running instance that the D-Bus hand-off above could not reach.
      eprintln!("Harmony failed to start: {e}");
      std::process::exit(1);
    }
  };
  app.run(|app, event| {
    // macOS: the close button hides the window to the tray (setup_desktop); a Dock icon
    // click (applicationShouldHandleReopen) brings it back, as for any macOS app.
    #[cfg(target_os = "macos")]
    {
      if let tauri::RunEvent::Reopen { .. } = event {
        reveal_main(app);
      }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
  });
}
