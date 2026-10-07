// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// CEF re-executes this binary for its renderer, GPU and utility processes; the
// entry point dispatches those before the app starts.
#[cfg_attr(target_os = "linux", tauri_runtime_cef::cef_entry_point)]
fn main() {
  app_lib::run();
}
