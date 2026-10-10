//! WASAPI process loopback, after the Windows SDK ApplicationLoopback sample. The virtual
//! device "VAD\Process_Loopback" captures one process tree (INCLUDE) or every process but one
//! tree (EXCLUDE). It has no mix format: the client asks for 48 kHz stereo s16 and the engine
//! converts. WebView2's processes descend from this one, so EXCLUDE with this PID keeps the
//! call's playback out of the stream.

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

use crate::{Error, Scope, Sink, Started, Target, WindowRef, CHANNELS, SAMPLE_RATE};

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

fn os_build() -> Option<u32> {
  let mut buf = [0u16; 32];
  let mut size = (buf.len() * 2) as u32;
  let status = unsafe {
    RegGetValueW(
      HKEY_LOCAL_MACHINE,
      w!("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"),
      w!("CurrentBuildNumber"),
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
  String::from_utf16_lossy(&buf[..len]).trim().parse().ok()
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

struct TitleSearch {
  title: Vec<u16>,
  matches: Vec<HWND>,
}

unsafe extern "system" fn visible_window_with_title(hwnd: HWND, lparam: LPARAM) -> BOOL {
  let search = unsafe { &mut *(lparam.0 as *mut TitleSearch) };
  if unsafe { IsWindowVisible(hwnd) }.as_bool() {
    let mut buf = [0u16; 512];
    let len = unsafe { GetWindowTextW(hwnd, &mut buf) };
    if len > 0 && buf[..len as usize] == search.title[..] {
      search.matches.push(hwnd);
    }
  }
  BOOL(1)
}

fn window_by_title(title: &str) -> Option<HWND> {
  let mut search = TitleSearch { title: title.encode_utf16().collect(), matches: Vec::new() };
  let _ = unsafe { EnumWindows(Some(visible_window_with_title), LPARAM(&mut search as *mut _ as isize)) };
  match search.matches.as_slice() {
    [only] => Some(*only),
    _ => None,
  }
}

/// (process id, loopback mode, what was resolved)
fn resolve(target: &Target) -> (u32, PROCESS_LOOPBACK_MODE, Started) {
  let own = unsafe { GetCurrentProcessId() };
  let system = |detail: String| {
    (own, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, Started { scope: Scope::System, app: None, detail })
  };
  let hwnd = match target {
    Target::System => return system("system: every process but this tree".into()),
    Target::Window(WindowRef::Id(id)) => {
      let hwnd = HWND(*id as usize as *mut c_void);
      if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return system(format!("system: hwnd {id:#x} is not a window"));
      }
      hwnd
    }
    Target::Window(WindowRef::Title(title)) => match window_by_title(title) {
      Some(hwnd) => hwnd,
      None => return system(format!("system: no single visible window titled {title:?}")),
    },
  };
  let pid = app_pid_for_window(hwnd);
  if pid == 0 || pid == own {
    return system(format!("system: window {:#x} belongs to pid {pid}", hwnd.0 as usize));
  }
  let image = process_image(pid);
  let detail = format!("app: pid {pid} ({}) from window {:#x}", image.as_deref().unwrap_or("?"), hwnd.0 as usize);
  let app = image.map(|name| match name.len().checked_sub(4) {
    Some(cut) if name.get(cut..).is_some_and(|ext| ext.eq_ignore_ascii_case(".exe")) => name[..cut].to_string(),
    _ => name,
  });
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
  let prop = PROPVARIANT {
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
  };
  let (tx, rx) = mpsc::sync_channel(1);
  let handler: IActivateAudioInterfaceCompletionHandler = Completion(tx).into();
  let operation = unsafe {
    ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&prop), &handler)
  }
  .map_err(|e| Error::Unsupported(format!("process loopback activation: {e}")))?;
  rx.recv_timeout(Duration::from_secs(5))
    .map_err(|_| Error::Failed("process loopback activation timed out".into()))?;
  let mut result = HRESULT(0);
  let mut unknown: Option<IUnknown> = None;
  unsafe { operation.GetActivateResult(&mut result, &mut unknown) }.map_err(|e| failed("GetActivateResult", e))?;
  result.ok().map_err(|e| failed("process loopback activation", e))?;
  unknown
    .ok_or_else(|| Error::Failed("activation returned no interface".into()))?
    .cast::<IAudioClient>()
    .map_err(|e| failed("IAudioClient", e))
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
  Ok(stream)
}

fn pump(stream: &Stream, stop: &AtomicBool, sink: &mut Sink) -> Result<(), Error> {
  let mut block: Vec<i16> = Vec::new();
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
