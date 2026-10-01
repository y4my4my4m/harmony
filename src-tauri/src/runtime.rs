// CEF runtime configuration for the Linux desktop build.

use tauri::webview::{PermissionKind, PermissionResponse, Webview};
use tauri_runtime_cef::Cef;

pub fn cef() -> Cef {
  // Chromium otherwise installs distro-provided external extensions
  // (/usr/share/chromium/extensions, e.g. Plasma Browser Integration) into the
  // app profile and launches their native messaging hosts. A value-less switch
  // needs its dashes: without them the runtime appends a positional argument.
  let cef = Cef::default().command_line_arg("--disable-extensions", None::<String>);

  // The runtime pins Chromium to X11 (XWayland on a Wayland session), where the
  // X11 capturer sees only XWayland windows. The PipeWire capturer goes through
  // xdg-desktop-portal and its picker instead.
  let cef = if std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v == "wayland") {
    cef.enable_features(["WebRTCPipeWireCapturer"])
  } else {
    cef
  };

  let cef = match sandbox() {
    Sandbox::Namespaces => cef.sandbox(tauri_runtime_cef::SandboxPolicy::Required),
    // Chromium tries namespaces first and only falls back to the helper when
    // its own check fails; that check does not exercise a capability.
    Sandbox::SetuidHelper => cef
      .sandbox(tauri_runtime_cef::SandboxPolicy::Required)
      .command_line_arg("--disable-namespace-sandbox", None::<String>),
    Sandbox::Unavailable => {
      eprintln!(
        "[cef] running without Chromium's sandbox: unprivileged user namespaces are unavailable and no usable setuid chrome-sandbox"
      );
      cef.sandbox(tauri_runtime_cef::SandboxPolicy::Disabled)
    }
  };

  // DevTools protocol for driving the real UI from Playwright; e2e builds only.
  #[cfg(feature = "e2e")]
  let cef = match std::env::var("HARMONY_CEF_CDP_PORT").ok().and_then(|p| p.parse().ok()) {
    Some(port) => cef.remote_debugging(tauri_runtime_cef::RemoteDebugging::Port {
      port,
      allowed_origins: Vec::new(),
    }),
    None => cef,
  };
  // Synthetic camera, microphone and display source; e2e builds only.
  #[cfg(feature = "e2e")]
  let cef = if std::env::var_os("HARMONY_CEF_FAKE_DEVICES").is_some() {
    cef.command_line_arg("--use-fake-device-for-media-stream", None::<String>)
  } else {
    cef
  };
  // Media prompts and the capture picker accepted without UI (entire screen); e2e builds only.
  #[cfg(feature = "e2e")]
  let cef = if std::env::var_os("HARMONY_CEF_AUTO_ACCEPT").is_some() {
    cef.command_line_arg("--use-fake-ui-for-media-stream", None::<String>)
  } else {
    cef
  };
  // Chromium's capture picker answered with the named source; e2e builds only.
  #[cfg(feature = "e2e")]
  let cef = match std::env::var("HARMONY_CEF_PICK_SOURCE") {
    Ok(title) => cef.command_line_arg("auto-select-desktop-capture-source", Some(title)),
    Err(_) => cef,
  };

  cef
}

// Microphone and camera are granted to the app origin without a prompt; other
// kinds keep CEF's handling. DisplayCapture stays Default: CEF answers it with
// Chromium's source picker either way.
pub fn on_permission_request(webview: Webview, kind: PermissionKind) -> PermissionResponse {
  match kind {
    PermissionKind::Microphone | PermissionKind::Camera if is_app_origin(&webview) => {
      PermissionResponse::Allow
    }
    _ => PermissionResponse::Default,
  }
}

// CEF serves bundled assets from http://tauri.localhost; dev builds load the Vite server.
const APP_ORIGIN: &str = "http://tauri.localhost";

fn is_app_origin(webview: &Webview) -> bool {
  let Ok(url) = webview.url() else { return false };
  let host = url.host_str();
  let dev_server = cfg!(dev) && matches!(host, Some("localhost") | Some("127.0.0.1"));
  url.scheme() == "http" && (host == Some("tauri.localhost") || dev_server)
}

// Chromium's Local Network Access check holds requests from the app origin to
// loopback and private addresses (a LAN or localhost instance, a LAN LiveKit
// server) behind a permission bubble. Granted to the app origin only; embedded
// third-party frames keep the check.
pub fn allow_local_network(window: &tauri::WebviewWindow) {
  use tauri_runtime_cef::cef::{
    CefString, ContentSettingTypes, ContentSettingValues, ImplBrowser, ImplBrowserHost,
    ImplRequestContext,
  };
  use tauri_runtime_cef::WebviewCefExt;

  let result = window.with_cef_webview(|webview| {
    let Some(context) = webview.browser().host().and_then(|host| host.request_context()) else {
      return;
    };
    let origin = CefString::from(APP_ORIGIN);
    for kind in [
      ContentSettingTypes::LOCAL_NETWORK_ACCESS,
      ContentSettingTypes::LOCAL_NETWORK,
      ContentSettingTypes::LOOPBACK_NETWORK,
    ] {
      context.set_content_setting(Some(&origin), Some(&origin), kind, ContentSettingValues::ALLOW);
    }
  });
  if let Err(e) = result {
    eprintln!("[cef] local network grant failed: {e}");
  }
}

// Chromium's base::MessagePumpGlib attaches a work source to the default GLib
// context. CEF's external pump (MessagePumpExternal) derives from it but never
// enters its Run(), and MessagePumpGlib::HandlePrepare returns a timeout of 0
// while state_ is null, so every blocking g_main_context_iteration returns at
// once and the main thread spins at 100% of a core. Work reaches the runtime's
// own pump through OnScheduleMessagePumpWork instead, so the source is dead;
// MessagePumpGlib's destructor destroys it again, a no-op in GLib.
// Recognised by: prepare in libcef, G_PRIORITY_DEFAULT_IDLE (kPriorityWork), one
// pipe fd (Chromium's X11 source polls a socket; the runtime's pump is not in
// libcef). Main thread, after cef::initialize. tauri-runtime-cef 3.0.0-alpha.4
// does not destroy it (tauri-apps/tauri#16189).
pub fn destroy_chromium_work_source() -> usize {
  fn module_base(address: *const libc::c_void) -> Option<*mut libc::c_void> {
    let mut info: libc::Dl_info = unsafe { std::mem::zeroed() };
    (unsafe { libc::dladdr(address, &mut info) } != 0).then_some(info.dli_fbase)
  }

  let cef_initialize = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"cef_initialize".as_ptr()) };
  let Some(cef_base) = (!cef_initialize.is_null()).then(|| module_base(cef_initialize)).flatten()
  else {
    return 0;
  };

  let mut destroyed = 0;
  unsafe {
    let context = glib_sys::g_main_context_default();
    // Ids are allocated sequentially; a fresh attach yields the next one.
    let probe = glib_sys::g_idle_source_new();
    let upper = glib_sys::g_source_attach(probe, context);
    glib_sys::g_source_destroy(probe);
    glib_sys::g_source_unref(probe);

    for id in 1..upper {
      let source = glib_sys::g_main_context_find_source_by_id(context, id);
      if source.is_null() || (*source).source_funcs.is_null() {
        continue;
      }
      let Some(prepare) = (*(*source).source_funcs).prepare else { continue };
      if module_base(prepare as *const libc::c_void) != Some(cef_base)
        || glib_sys::g_source_get_priority(source) != glib_sys::G_PRIORITY_DEFAULT_IDLE
      {
        continue;
      }
      let poll_fds = (*source).poll_fds;
      if poll_fds.is_null() || !(*poll_fds).next.is_null() {
        continue;
      }
      let fd = (*((*poll_fds).data as *const glib_sys::GPollFD)).fd;
      let mut stat: libc::stat = std::mem::zeroed();
      if libc::fstat(fd, &mut stat) != 0 || (stat.st_mode & libc::S_IFMT) != libc::S_IFIFO {
        continue;
      }
      glib_sys::g_source_destroy(source);
      destroyed += 1;
    }
  }
  destroyed
}

// A second launch must reach the running instance before CEF initializes: CEF's
// process singleton otherwise catches it inside cef::initialize, which then fails
// (WebviewRuntimeNotInstalled) without notifying the app. Calls the D-Bus object
// tauri-plugin-single-instance serves (name `<identifier>.SingleInstance`, path
// with '.' -> '/' and '-' -> '_', method org.SingleInstance.DBus.ExecuteCallback).
// Returns true when a running instance took the launch.
pub fn hand_off_to_running_instance(identifier: &str) -> bool {
  let name = format!("{identifier}.SingleInstance");
  let path = format!("/{}", name.replace('.', "/").replace('-', "_"));
  let args: Vec<String> = std::env::args().collect();
  let cwd = std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default();

  let Ok(connection) = zbus::blocking::Connection::session() else {
    return false;
  };
  connection
    .call_method(
      Some(name.as_str()),
      path.as_str(),
      Some("org.SingleInstance.DBus"),
      "ExecuteCallback",
      &(args, cwd),
    )
    .is_ok()
}

// Chromium sandboxes its children with unprivileged user namespaces, else with the
// setuid chrome-sandbox helper; with neither it aborts at startup ("No usable
// sandbox!", or "SUID sandbox helper binary was found, but is not configured
// correctly" for an AppImage's inert copy). The runtime's Auto policy decides from
// the AppArmor and max_user_namespaces sysctls alone: it misses seccomp filters,
// kernel.unprivileged_userns_clone=0 and container runtimes, and drops an
// AppImage's sandbox under apparmor_restrict_unprivileged_userns=1 even when an
// AppArmor profile grants it user namespaces (fix-namespaces.hook installs one).
// Probed directly instead; the policy is always Required or Disabled.
enum Sandbox {
  Namespaces,
  SetuidHelper,
  Unavailable,
}

fn sandbox() -> Sandbox {
  if user_namespaces_usable() {
    return Sandbox::Namespaces;
  }
  // An AppImage is mounted nosuid, so its bundled helper never counts. Inside a
  // container the helper's own clone(CLONE_NEWPID | CLONE_NEWNET) hits the same
  // seccomp filter, so it does not count there either.
  let appimage = std::env::var_os("APPIMAGE").is_some_and(|p| !p.is_empty());
  if !appimage && !in_container() && setuid_helper_usable() {
    return Sandbox::SetuidHelper;
  }
  Sandbox::Unavailable
}

// Markers left by docker (/.dockerenv), podman (/run/.containerenv) and
// systemd-nspawn / toolbox (`container` in the environment).
fn in_container() -> bool {
  std::path::Path::new("/.dockerenv").exists()
    || std::path::Path::new("/run/.containerenv").exists()
    || std::env::var_os("container").is_some()
}

// Chromium's namespace sandbox: clone(CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET),
// then chroot inside the new namespace (Credentials::DropFileSystemAccess).
// Ubuntu 23.10+ (kernel.apparmor_restrict_unprivileged_userns=1) lets the
// unshare succeed and denies every capability inside, so the chroot is the test.
fn user_namespaces_usable() -> bool {
  unsafe {
    match libc::fork() {
      -1 => false,
      0 => {
        let flags = libc::CLONE_NEWUSER | libc::CLONE_NEWPID | libc::CLONE_NEWNET;
        let ok = libc::unshare(flags) == 0 && libc::chroot(c"/".as_ptr()) == 0;
        libc::_exit(if ok { 0 } else { 1 });
      }
      child => {
        let mut status = 0;
        libc::waitpid(child, &mut status, 0) == child
          && libc::WIFEXITED(status)
          && libc::WEXITSTATUS(status) == 0
      }
    }
  }
}

// Chromium's checks on the helper: owned by root, setuid, executable by others,
// on a filesystem that honours setuid.
fn setuid_helper_usable() -> bool {
  use std::os::unix::fs::MetadataExt;
  let helper = match std::env::var_os("CHROME_DEVEL_SANDBOX").filter(|p| !p.is_empty()) {
    Some(path) => std::path::PathBuf::from(path),
    None => match std::env::current_exe() {
      Ok(exe) => exe.with_file_name("chrome-sandbox"),
      Err(_) => return false,
    },
  };
  let Ok(meta) = std::fs::metadata(&helper) else { return false };
  if meta.uid() != 0 || meta.mode() & 0o4000 == 0 || meta.mode() & 0o001 == 0 {
    return false;
  }
  let Ok(c_path) = std::ffi::CString::new(helper.as_os_str().as_encoded_bytes()) else {
    return false;
  };
  let mut vfs: libc::statvfs = unsafe { std::mem::zeroed() };
  unsafe { libc::statvfs(c_path.as_ptr(), &mut vfs) == 0 && vfs.f_flag & libc::ST_NOSUID == 0 }
}
