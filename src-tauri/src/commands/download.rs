//! Downloads into the Downloads folder (harmony-download), for the page's saveFile
//! (src/services/downloads.ts): progress and retries reach the page through the channel; the id
//! names the download for download_cancel.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

#[derive(Clone, serde::Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum DownloadEvent {
  Progress { loaded: u64, total: u64 },
  Retrying { attempt: u32 },
}

fn running() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
  static RUNNING: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
  RUNNING.get_or_init(Default::default)
}

/// Saves `url` into the Downloads folder as `file_name`; returns the path written. Rejects with
/// "cancelled" after download_cancel.
#[tauri::command]
pub async fn download_file(
  app: AppHandle,
  id: String,
  url: String,
  file_name: String,
  on_event: Channel<DownloadEvent>,
) -> Result<String, String> {
  let dir = app.path().download_dir().map_err(|e| e.to_string())?;
  let client = harmony_download::client()?;
  let cancel = Arc::new(AtomicBool::new(false));
  running().lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), cancel.clone());
  let result = harmony_download::download(
    &client,
    &url,
    &dir,
    &file_name,
    &cancel,
    &harmony_download::RETRY_DELAYS,
    move |event| {
      let _ = on_event.send(match event {
        harmony_download::Event::Progress { loaded, total } => DownloadEvent::Progress { loaded, total },
        harmony_download::Event::Retrying { attempt } => DownloadEvent::Retrying { attempt },
      });
    },
  )
  .await;
  running().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
  result.map(|path| path.to_string_lossy().into_owned()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn download_cancel(id: String) {
  if let Some(flag) = running().lock().unwrap_or_else(|e| e.into_inner()).get(&id) {
    flag.store(true, Ordering::SeqCst);
  }
}
