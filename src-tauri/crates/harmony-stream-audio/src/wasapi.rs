//! WASAPI process loopback, after the Windows SDK ApplicationLoopback sample. The virtual
//! device "VAD\Process_Loopback" captures one process tree (INCLUDE) or every process but one
//! tree (EXCLUDE). It has no mix format: the client asks for 48 kHz stereo s16 and the engine
//! converts. WebView2's processes descend from this one, so EXCLUDE with this PID keeps the
//! call's playback out of the stream. A browser plays from a child of the process owning its
//! window (Chrome: the audio.mojom.AudioService utility), which INCLUDE of that tree takes in
//! (CI probe, Chrome 155).

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::Duration;

use windows::core::{implement, w, Interface, Ref, BOOL, HRESULT, IUnknown, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
  ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
  IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
  IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
  AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS,
  AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
  AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE,
  PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
  VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX, WAVE_FORMAT_PCM,
};
use windows::Win32::System::Com::StructuredStorage::{
  PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, BLOB, COINIT_MULTITHREADED};
use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
use windows::Win32::System::Threading::{
  CreateEventW, GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject,
  PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::System::Variant::VT_BLOB;
use windows::Win32::UI::WindowsAndMessaging::{
  EnumChildWindows, EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindow, IsWindowVisible,
};

use crate::{titled, AppInfo, AppRef, Error, Scope, Sink, Started, Target, WindowInfo, WindowRef, CHANNELS, SAMPLE_RATE};

/// Windows 10 2004. Process loopback activation fails on earlier builds.
const MIN_BUILD: u32 = 19041;
/// 20 ms, in 100 ns units.
const BUFFER_100NS: i64 = 200_000;

pub struct Capture {
  stop: Arc<AtomicBool>,
  thread: Option<JoinHandle<()>>,
}

impl Drop for Capture {
  fn drop(&mut self) {
    self.stop.store(true, Ordering::SeqCst);
    if let Some(thread) = self.thread.take() {
      let _ = thread.join();
    }
  }
}

/// A REG_SZ under HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion.
fn current_version(value: PCWSTR) -> Option<String> {
  let mut buf = [0u16; 64];
  let mut size = (buf.len() * 2) as u32;
  let status = unsafe {
    RegGetValueW(
      HKEY_LOCAL_MACHINE,
      w!("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"),
      value,
      RRF_RT_REG_SZ,
      None,
      Some(buf.as_mut_ptr() as *mut c_void),
      Some(&mut size),
    )
  };
  if status.is_err() {
    return None;
  }
  let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
  Some(String::from_utf16_lossy(&buf[..len]).trim().to_string())
}

fn os_build() -> Option<u32> {
  current_version(w!("CurrentBuildNumber"))?.parse().ok()
}

pub fn os_version() -> Option<String> {
  let build = os_build()?;
  Some(match current_version(w!("DisplayVersion")) {
    Some(release) if !release.is_empty() => format!("Windows {release} (build {build})"),
    _ => format!("Windows build {build}"),
  })
}

pub fn support() -> Result<(), Error> {
  match os_build() {
    Some(build) if build < MIN_BUILD => Err(Error::Unsupported(format!(
      "Windows build {build}; program audio needs Windows 10 version 2004 (build {MIN_BUILD}) or later"
    ))),
    _ => Ok(()),
  }
}

fn process_image(pid: u32) -> Option<String> {
  let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
  let mut buf = [0u16; 1024];
  let mut size = buf.len() as u32;
  let ok = unsafe { QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size) };
  let _ = unsafe { CloseHandle(handle) };
  ok.ok()?;
  let path = String::from_utf16_lossy(&buf[..size as usize]);
  path.rsplit(['\\', '/']).next().map(str::to_string)
}

fn window_pid(hwnd: HWND) -> u32 {
  let mut pid = 0u32;
  unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
  pid
}

struct ChildSearch {
  host_pid: u32,
  found: u32,
}

unsafe extern "system" fn child_with_other_pid(hwnd: HWND, lparam: LPARAM) -> BOOL {
  let search = unsafe { &mut *(lparam.0 as *mut ChildSearch) };
  let pid = window_pid(hwnd);
  if pid != 0 && pid != search.host_pid {
    search.found = pid;
    return BOOL(0);
  }
  BOOL(1)
}

/// A UWP app's top-level window belongs to ApplicationFrameHost.exe; its content is a child
/// window of the app's own process.
fn app_pid_for_window(hwnd: HWND) -> u32 {
  let pid = window_pid(hwnd);
  let is_frame_host = process_image(pid).is_some_and(|name| name.eq_ignore_ascii_case("ApplicationFrameHost.exe"));
  if !is_frame_host {
    return pid;
  }
  let mut search = ChildSearch { host_pid: pid, found: 0 };
  // FALSE also means the callback stopped the walk; `found` carries the result.
  let _ = unsafe { EnumChildWindows(Some(hwnd), Some(child_with_other_pid), LPARAM(&mut search as *mut _ as isize)) };
  if search.found != 0 { search.found } else { pid }
}

unsafe extern "system" fn collect_titled_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
  let found = unsafe { &mut *(lparam.0 as *mut Vec<(HWND, String)>) };
  if unsafe { IsWindowVisible(hwnd) }.as_bool() {
    let mut buf = [0u16; 512];
    let len = unsafe { GetWindowTextW(hwnd, &mut buf) };
    if len > 0 {
      found.push((hwnd, String::from_utf16_lossy(&buf[..len as usize])));
    }
  }
  BOOL(1)
}

/// Visible top-level windows with a title, in Z order.
fn titled_windows() -> Vec<(HWND, String)> {
  let mut found: Vec<(HWND, String)> = Vec::new();
  let _ = unsafe { EnumWindows(Some(collect_titled_window), LPARAM(&mut found as *mut _ as isize)) };
  found
}

/// The one application process owning every window a title matches.
fn app_by_title(title: &str) -> Option<HWND> {
  let windows = titled_windows();
  let titles: Vec<String> = windows.iter().map(|(_, t)| t.clone()).collect();
  let matched = titled(&titles, title);
  let first = windows[*matched.first()?].0;
  let pid = app_pid_for_window(first);
  matched.iter().all(|&i| app_pid_for_window(windows[i].0) == pid).then_some(first)
}

fn strip_exe(name: String) -> String {
  match name.len().checked_sub(4) {
    Some(cut) if name.get(cut..).is_some_and(|ext| ext.eq_ignore_ascii_case(".exe")) => name[..cut].to_string(),
    _ => name,
  }
}

pub fn windows() -> Result<Vec<WindowInfo>, Error> {
  Ok(
    titled_windows()
      .into_iter()
      .map(|(hwnd, title)| {
        let pid = app_pid_for_window(hwnd);
        WindowInfo { id: hwnd.0 as usize as u64, title, pid, app: process_image(pid).map(strip_exe).unwrap_or_default() }
      })
      .collect(),
  )
}

pub fn applications() -> Result<Vec<AppInfo>, Error> {
  let mut apps: Vec<AppInfo> = Vec::new();
  for (hwnd, _) in titled_windows() {
    let pid = app_pid_for_window(hwnd);
    if pid == 0 || apps.iter().any(|a| a.pid == pid) {
      continue;
    }
    let image = process_image(pid).unwrap_or_default();
    apps.push(AppInfo { pid, name: strip_exe(image.clone()), bundle: image, responsible: None, windowed: true });
  }
  Ok(apps)
}

/// (process id, loopback mode, what was resolved)
fn resolve(target: &Target) -> (u32, PROCESS_LOOPBACK_MODE, Started) {
  let own = unsafe { GetCurrentProcessId() };
  let system = |detail: String| {
    (own, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, Started { scope: Scope::System, app: None, detail })
  };
  let (pid, from) = match target {
    Target::System => return system("system: every process but this tree".into()),
    Target::Window(WindowRef::Id(id)) => {
      let hwnd = HWND(*id as usize as *mut c_void);
      if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return system(format!("system: hwnd {id:#x} is not a window"));
      }
      (app_pid_for_window(hwnd), format!("window {:#x}", hwnd.0 as usize))
    }
    Target::Window(WindowRef::Title(title)) => match app_by_title(title) {
      Some(hwnd) => (app_pid_for_window(hwnd), format!("window {:#x}", hwnd.0 as usize)),
      None => return system(format!("system: no single application has a visible window titled {title:?}")),
    },
    Target::App(AppRef::Pid(pid)) => (*pid, "pid".into()),
    Target::App(AppRef::Bundle(name)) => {
      let owners: Vec<u32> = applications()
        .unwrap_or_default()
        .into_iter()
        .filter(|a| a.bundle.eq_ignore_ascii_case(name))
        .map(|a| a.pid)
        .collect();
      match owners.as_slice() {
        [pid] => (*pid, format!("executable {name}")),
        _ => return system(format!("system: {} windowed processes run {name}", owners.len())),
      }
    }
  };
  if pid == 0 || pid == own {
    return system(format!("system: {from} belongs to pid {pid}"));
  }
  let image = process_image(pid);
  let detail = format!("app: pid {pid} ({}) from {from}", image.as_deref().unwrap_or("?"));
  let app = image.map(strip_exe);
  (pid, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, Started { scope: Scope::App, app, detail })
}

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Completion(mpsc::SyncSender<()>);

impl IActivateAudioInterfaceCompletionHandler_Impl for Completion_Impl {
  fn ActivateCompleted(&self, _operation: Ref<IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
    let _ = self.0.try_send(());
    Ok(())
  }
}

fn failed(what: &str, e: windows::core::Error) -> Error {
  Error::Failed(format!("{what}: {e}"))
}

fn activate(pid: u32, mode: PROCESS_LOOPBACK_MODE) -> Result<IAudioClient, Error> {
  let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
    ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
      ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS { TargetProcessId: pid, ProcessLoopbackMode: mode },
    },
  };
  // PROPVARIANT's Drop runs PropVariantClear, which CoTaskMemFrees a VT_BLOB's data; this blob
  // points at `params` on the stack.
  let prop = std::mem::ManuallyDrop::new(PROPVARIANT {
    Anonymous: PROPVARIANT_0 {
      Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
        vt: VT_BLOB,
        wReserved1: 0,
        wReserved2: 0,
        wReserved3: 0,
        Anonymous: PROPVARIANT_0_0_0 {
          blob: BLOB {
            cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
            pBlobData: &mut params as *mut _ as *mut u8,
          },
        },
      }),
    },
  });
  let (tx, rx) = mpsc::sync_channel(1);
  let handler: IActivateAudioInterfaceCompletionHandler = Completion(tx).into();
  log::debug!("activating process loopback: pid {pid}, mode {}", mode.0);
  let operation = unsafe {
    ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&*prop), &handler)
  }
  .map_err(|e| Error::Unsupported(format!("process loopback activation: {e}")))?;
  log::debug!("activation requested");
  rx.recv_timeout(Duration::from_secs(5))
    .map_err(|_| Error::Failed("process loopback activation timed out".into()))?;
  log::debug!("activation completed");
  let mut result = HRESULT(0);
  let mut unknown: Option<IUnknown> = None;
  unsafe { operation.GetActivateResult(&mut result, &mut unknown) }.map_err(|e| failed("GetActivateResult", e))?;
  log::debug!("activation result {:#x}", result.0);
  result.ok().map_err(|e| failed("process loopback activation", e))?;
  let client = unknown
    .ok_or_else(|| Error::Failed("activation returned no interface".into()))?
    .cast::<IAudioClient>()
    .map_err(|e| failed("IAudioClient", e))?;
  log::debug!("IAudioClient obtained");
  Ok(client)
}

struct Stream {
  client: IAudioClient,
  capture: IAudioCaptureClient,
  event: HANDLE,
}

impl Drop for Stream {
  fn drop(&mut self) {
    let _ = unsafe { self.client.Stop() };
    let _ = unsafe { CloseHandle(self.event) };
  }
}

fn open(pid: u32, mode: PROCESS_LOOPBACK_MODE) -> Result<Stream, Error> {
  let client = activate(pid, mode)?;
  let block_align = (CHANNELS * 2) as u16;
  let format = WAVEFORMATEX {
    wFormatTag: WAVE_FORMAT_PCM as u16,
    nChannels: CHANNELS as u16,
    nSamplesPerSec: SAMPLE_RATE,
    nAvgBytesPerSec: SAMPLE_RATE * block_align as u32,
    nBlockAlign: block_align,
    wBitsPerSample: 16,
    cbSize: 0,
  };
  log::debug!("initializing IAudioClient");
  unsafe {
    client.Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
      BUFFER_100NS,
      0,
      &format,
      None,
    )
  }
  .map_err(|e| failed("IAudioClient::Initialize", e))?;
  log::debug!("IAudioClient initialized");
  let event = unsafe { CreateEventW(None, false, false, PCWSTR::null()) }.map_err(|e| failed("CreateEvent", e))?;
  let stream = Stream {
    capture: match unsafe { client.GetService::<IAudioCaptureClient>() } {
      Ok(capture) => capture,
      Err(e) => {
        let _ = unsafe { CloseHandle(event) };
        return Err(failed("IAudioCaptureClient", e));
      }
    },
    client,
    event,
  };
  unsafe { stream.client.SetEventHandle(stream.event) }.map_err(|e| failed("SetEventHandle", e))?;
  unsafe { stream.client.Start() }.map_err(|e| failed("IAudioClient::Start", e))?;
  log::debug!("capture started");
  Ok(stream)
}

fn pump(stream: &Stream, stop: &AtomicBool, sink: &mut Sink) -> Result<(), Error> {
  let mut block: Vec<i16> = Vec::new();
  let mut first = true;
  while !stop.load(Ordering::SeqCst) {
    if unsafe { WaitForSingleObject(stream.event, 100) } != WAIT_OBJECT_0 {
      continue;
    }
    loop {
      let packet = unsafe { stream.capture.GetNextPacketSize() }.map_err(|e| failed("GetNextPacketSize", e))?;
      if packet == 0 {
        break;
      }
      let mut data: *mut u8 = std::ptr::null_mut();
      let mut frames = 0u32;
      let mut flags = 0u32;
      unsafe { stream.capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None) }
        .map_err(|e| failed("GetBuffer", e))?;
      let samples = frames as usize * CHANNELS;
      if first {
        first = false;
        log::debug!("first packet: {frames} frames, flags {flags:#x}");
      }
      block.clear();
      if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
        block.resize(samples, 0);
      } else {
        block.extend_from_slice(unsafe { std::slice::from_raw_parts(data as *const i16, samples) });
      }
      unsafe { stream.capture.ReleaseBuffer(frames) }.map_err(|e| failed("ReleaseBuffer", e))?;
      if !block.is_empty() {
        sink(&block);
      }
    }
  }
  Ok(())
}

pub fn start(target: Target, mut sink: Sink) -> Result<(Capture, Started), Error> {
  support()?;
  let (pid, mode, started) = resolve(&target);
  let stop = Arc::new(AtomicBool::new(false));
  let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<(), Error>>(1);
  let thread_stop = stop.clone();
  let thread = std::thread::Builder::new()
    .name("stream-audio".into())
    .spawn(move || {
      let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
      log::debug!("capture thread: CoInitializeEx {:#x}", com.0);
      match open(pid, mode) {
        Ok(stream) => {
          let _ = ready_tx.send(Ok(()));
          if let Err(e) = pump(&stream, &thread_stop, &mut sink) {
            log::error!("stream audio stopped: {e}");
          }
        }
        Err(e) => {
          let _ = ready_tx.send(Err(e));
        }
      }
      if com.is_ok() {
        unsafe { CoUninitialize() };
      }
    })
    .map_err(|e| Error::Failed(format!("capture thread: {e}")))?;
  let capture = Capture { stop, thread: Some(thread) };
  match ready_rx.recv_timeout(Duration::from_secs(10)) {
    Ok(Ok(())) => Ok((capture, started)),
    Ok(Err(e)) => Err(e),
    Err(_) => Err(Error::Failed("capture did not start".into())),
  }
}
