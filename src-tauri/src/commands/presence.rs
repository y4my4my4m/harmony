#[cfg(desktop)]
pub use imp::*;

#[cfg(desktop)]
mod imp {
  use std::sync::atomic::{AtomicBool, Ordering};
  use std::sync::{Arc, Mutex};
  use std::time::Duration;

  use serde::Serialize;
  use sysinfo::System;
  use tauri::{AppHandle, Emitter, State};

  static GAMES_JSON: &str = include_str!("../games.json");

  #[derive(Clone, Serialize, PartialEq)]
  pub struct DetectedActivity {
    pub name: String,
    pub kind: String,
  }

  #[derive(Default)]
  pub struct PresenceState {
    running: Arc<AtomicBool>,
    last: Arc<Mutex<Option<DetectedActivity>>>,
  }

  // (needle_lowercase, display_name, kind); streaming matched first so an active
  // stream wins over the game being streamed
  fn rules() -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(GAMES_JSON) {
      for kind in ["streaming", "playing"] {
        if let Some(map) = v.get(kind).and_then(|m| m.as_object()) {
          for (needle, name) in map {
            if let Some(name) = name.as_str() {
              out.push((needle.to_lowercase(), name.to_string(), kind.to_string()));
            }
          }
        }
      }
    }
    out
  }

  fn scan(sys: &mut System, rules: &[(String, String, String)]) -> Option<DetectedActivity> {
    sys.refresh_processes();
    for process in sys.processes().values() {
      let pname = process.name().to_lowercase();
      for (needle, name, kind) in rules {
        if pname.contains(needle) {
          return Some(DetectedActivity { name: name.clone(), kind: kind.clone() });
        }
      }
    }
    None
  }

  #[tauri::command]
  pub fn presence_start(app: AppHandle, state: State<'_, PresenceState>) {
    if state.running.swap(true, Ordering::SeqCst) {
      return;
    }
    let running = state.running.clone();
    let last = state.last.clone();
    // sysinfo is blocking and System isn't Send across awaits — use a plain thread
    std::thread::spawn(move || {
      let rules = rules();
      let mut sys = System::new();
      while running.load(Ordering::SeqCst) {
        let found = scan(&mut sys, &rules);
        {
          let mut guard = last.lock().unwrap();
          if *guard != found {
            *guard = found.clone();
            let _ = app.emit("presence://game", found);
          }
        }
        // wake promptly on stop: 10s poll in 1s steps
        for _ in 0..10 {
          if !running.load(Ordering::SeqCst) {
            break;
          }
          std::thread::sleep(Duration::from_secs(1));
        }
      }
    });
  }

  #[tauri::command]
  pub fn presence_stop(app: AppHandle, state: State<'_, PresenceState>) {
    state.running.store(false, Ordering::SeqCst);
    *state.last.lock().unwrap() = None;
    let _ = app.emit("presence://game", None::<DetectedActivity>);
  }

  #[tauri::command]
  pub fn presence_current(state: State<'_, PresenceState>) -> Option<DetectedActivity> {
    state.last.lock().unwrap().clone()
  }
}
