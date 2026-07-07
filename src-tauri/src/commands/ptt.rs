// Global push-to-talk capture. rdev observes raw input without grabbing keys
// (global-shortcut registration would swallow the bound key for every other app).
// Only the bound key's press state is emitted to the webview — nothing else leaves.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Deserialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Target {
  Key(rdev::Key),
  Button(rdev::Button),
}

#[derive(Clone, Copy)]
struct Binding {
  target: Target,
  ctrl: bool,
  alt: bool,
  shift: bool,
  meta: bool,
}

#[derive(Deserialize)]
pub struct BindingDto {
  key: String,
  ctrl: bool,
  alt: bool,
  shift: bool,
  meta: bool,
}

#[derive(Default)]
struct Mods {
  ctrl: bool,
  alt: bool,
  shift: bool,
  meta: bool,
}

static BINDING: Mutex<Option<Binding>> = Mutex::new(None);
static LISTENER_RUNNING: AtomicBool = AtomicBool::new(false);
static LISTENER_FAILED: AtomicBool = AtomicBool::new(false);

// Some = arm, None = disarm; returns whether capture is active
#[tauri::command]
pub fn ptt_set_binding(app: AppHandle, binding: Option<BindingDto>) -> bool {
  let parsed = binding.and_then(|dto| {
    parse_target(&dto.key).map(|target| Binding {
      target,
      ctrl: dto.ctrl,
      alt: dto.alt,
      shift: dto.shift,
      meta: dto.meta,
    })
  });
  let armed = parsed.is_some();
  *BINDING.lock().unwrap() = parsed;

  if !armed {
    return false;
  }
  if !capture_supported() || LISTENER_FAILED.load(Ordering::SeqCst) {
    return false;
  }
  ensure_listener(app);
  true
}

fn capture_supported() -> bool {
  // rdev observes through X11; pure Wayland sessions can't see global input
  #[cfg(target_os = "linux")]
  {
    if std::env::var("XDG_SESSION_TYPE").map(|v| v == "wayland").unwrap_or(false) {
      return false;
    }
  }
  true
}

fn ensure_listener(app: AppHandle) {
  if LISTENER_RUNNING.swap(true, Ordering::SeqCst) {
    return;
  }
  // rdev::listen blocks its thread forever; disarming happens by clearing BINDING
  std::thread::spawn(move || {
    let mut mods = Mods::default();
    let mut ptt_down = false;
    let emitter = app.clone();

    let result = rdev::listen(move |event| {
      let (target, is_press) = match event.event_type {
        rdev::EventType::KeyPress(key) => {
          set_modifier(key, true, &mut mods);
          (Target::Key(key), true)
        }
        rdev::EventType::KeyRelease(key) => {
          set_modifier(key, false, &mut mods);
          (Target::Key(key), false)
        }
        rdev::EventType::ButtonPress(btn) => (Target::Button(btn), true),
        rdev::EventType::ButtonRelease(btn) => (Target::Button(btn), false),
        _ => return,
      };

      let Some(binding) = *BINDING.lock().unwrap() else { return };
      if binding.target != target {
        return;
      }

      if is_press {
        // press requires the exact modifier set; release matches the key alone so PTT can't stick
        let mods_match = mods.ctrl == binding.ctrl
          && mods.alt == binding.alt
          && mods.shift == binding.shift
          && mods.meta == binding.meta;
        if mods_match && !ptt_down {
          ptt_down = true;
          let _ = emitter.emit("ptt://state", true);
        }
      } else if ptt_down {
        ptt_down = false;
        let _ = emitter.emit("ptt://state", false);
      }
    });

    if let Err(e) = result {
      // typically macOS without accessibility permission; frontend falls back to window listeners
      eprintln!("[ptt] global input listener failed: {e:?}");
      LISTENER_FAILED.store(true, Ordering::SeqCst);
      LISTENER_RUNNING.store(false, Ordering::SeqCst);
      let _ = app.emit("ptt://unavailable", ());
    }
  });
}

fn set_modifier(key: rdev::Key, down: bool, mods: &mut Mods) {
  use rdev::Key::*;
  match key {
    ControlLeft | ControlRight => mods.ctrl = down,
    Alt | AltGr => mods.alt = down,
    ShiftLeft | ShiftRight => mods.shift = down,
    MetaLeft | MetaRight => mods.meta = down,
    _ => {}
  }
}

// browser MouseEvent.button -> rdev button (extra buttons differ per OS backend)
fn mouse_button(code: u8) -> rdev::Button {
  use rdev::Button;
  match code {
    0 => Button::Left,
    1 => Button::Middle,
    2 => Button::Right,
    3 if cfg!(windows) => Button::Unknown(1),
    4 if cfg!(windows) => Button::Unknown(2),
    3 if cfg!(target_os = "macos") => Button::Unknown(3),
    4 if cfg!(target_os = "macos") => Button::Unknown(4),
    3 => Button::Unknown(8), // X11 back
    4 => Button::Unknown(9), // X11 forward
    n => Button::Unknown(n),
  }
}

// browser KeyboardEvent.code -> rdev key
fn parse_target(code: &str) -> Option<Target> {
  use rdev::Key::*;

  if let Some(n) = code.strip_prefix("Mouse") {
    return n.parse::<u8>().ok().map(|b| Target::Button(mouse_button(b)));
  }

  let key = match code {
    "KeyA" => KeyA, "KeyB" => KeyB, "KeyC" => KeyC, "KeyD" => KeyD, "KeyE" => KeyE,
    "KeyF" => KeyF, "KeyG" => KeyG, "KeyH" => KeyH, "KeyI" => KeyI, "KeyJ" => KeyJ,
    "KeyK" => KeyK, "KeyL" => KeyL, "KeyM" => KeyM, "KeyN" => KeyN, "KeyO" => KeyO,
    "KeyP" => KeyP, "KeyQ" => KeyQ, "KeyR" => KeyR, "KeyS" => KeyS, "KeyT" => KeyT,
    "KeyU" => KeyU, "KeyV" => KeyV, "KeyW" => KeyW, "KeyX" => KeyX, "KeyY" => KeyY,
    "KeyZ" => KeyZ,
    "Digit0" => Num0, "Digit1" => Num1, "Digit2" => Num2, "Digit3" => Num3,
    "Digit4" => Num4, "Digit5" => Num5, "Digit6" => Num6, "Digit7" => Num7,
    "Digit8" => Num8, "Digit9" => Num9,
    "F1" => F1, "F2" => F2, "F3" => F3, "F4" => F4, "F5" => F5, "F6" => F6,
    "F7" => F7, "F8" => F8, "F9" => F9, "F10" => F10, "F11" => F11, "F12" => F12,
    "Space" => Space,
    "Tab" => Tab,
    "Enter" => Return,
    "Backspace" => Backspace,
    "CapsLock" => CapsLock,
    "Escape" => Escape,
    "Backquote" => BackQuote,
    "Minus" => Minus,
    "Equal" => Equal,
    "BracketLeft" => LeftBracket,
    "BracketRight" => RightBracket,
    "Backslash" => BackSlash,
    "Semicolon" => SemiColon,
    "Quote" => Quote,
    "Comma" => Comma,
    "Period" => Dot,
    "Slash" => Slash,
    "ArrowUp" => UpArrow,
    "ArrowDown" => DownArrow,
    "ArrowLeft" => LeftArrow,
    "ArrowRight" => RightArrow,
    "Insert" => Insert,
    "Delete" => Delete,
    "Home" => Home,
    "End" => End,
    "PageUp" => PageUp,
    "PageDown" => PageDown,
    "ShiftLeft" => ShiftLeft,
    "ShiftRight" => ShiftRight,
    "ControlLeft" => ControlLeft,
    "ControlRight" => ControlRight,
    "AltLeft" => Alt,
    "AltRight" => AltGr,
    "MetaLeft" => MetaLeft,
    "MetaRight" => MetaRight,
    "Numpad0" => Kp0, "Numpad1" => Kp1, "Numpad2" => Kp2, "Numpad3" => Kp3,
    "Numpad4" => Kp4, "Numpad5" => Kp5, "Numpad6" => Kp6, "Numpad7" => Kp7,
    "Numpad8" => Kp8, "Numpad9" => Kp9,
    "NumpadSubtract" => KpMinus,
    "NumpadAdd" => KpPlus,
    "NumpadMultiply" => KpMultiply,
    "NumpadDivide" => KpDivide,
    "NumpadDecimal" => KpDelete,
    "NumpadEnter" => KpReturn,
    _ => return None,
  };
  Some(Target::Key(key))
}
