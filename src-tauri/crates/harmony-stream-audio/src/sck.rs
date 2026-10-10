//! ScreenCaptureKit audio (macOS 13+). An SCStream with capturesAudio delivers the audio of the
//! applications its content filter admits: one application for a window share, every
//! application but this one otherwise. WKWebView plays the call from WebKit's GPU process;
//! ScreenCaptureKit attributes that audio to its responsible process, this app, and
//! excludesCurrentProcessAudio drops it. Applications whose responsible process is this one are
//! excluded from the filter as well.
//!
//! The stream also produces video, which nothing reads: 2x2 at one frame per second.
//! Audio arrives as f32, usually planar, at the configured 48 kHz.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;

use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{available, define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_core_audio_types::{
  kAudioFormatFlagIsFloat, kAudioFormatFlagIsNonInterleaved, kAudioFormatLinearPCM, AudioBuffer,
  AudioBufferList,
};
use objc2_core_foundation::CFRetained;
use objc2_core_media::{
  kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, CMAudioFormatDescriptionGetStreamBasicDescription,
  CMBlockBuffer, CMSampleBuffer, CMTime,
};
use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol};
use objc2_screen_capture_kit::{
  SCContentFilter, SCRunningApplication, SCShareableContent, SCStream, SCStreamConfiguration, SCStreamOutput,
  SCStreamOutputType, SCWindow,
};

use crate::{f32_to_i16, Error, Scope, Sink, Started, Target, WindowRef, CHANNELS, SAMPLE_RATE};

/// SCStreamErrorUserDeclined: Screen Recording is not granted.
const SC_USER_DECLINED: isize = -3801;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
  fn CGPreflightScreenCaptureAccess() -> bool;
}

/// TCC's Screen Recording answer for this code signature; never prompts.
pub fn permission_granted() -> bool {
  unsafe { CGPreflightScreenCaptureAccess() }
}

pub fn support() -> Result<(), Error> {
  if available!(macos = 13.0) {
    Ok(())
  } else {
    Err(Error::Unsupported("program audio needs macOS 13 or later".into()))
  }
}

fn ns_error(what: &str, error: &NSError) -> Error {
  let message = format!("{what}: {}", error.localizedDescription());
  if error.code() == SC_USER_DECLINED {
    Error::Permission(message)
  } else {
    Error::Failed(message)
  }
}

/// Snapshot of shareable content; immutable once delivered.
struct Content(Retained<SCShareableContent>);
// SAFETY: SCShareableContent is an immutable value object.
unsafe impl Send for Content {}

fn shareable_content() -> Result<Retained<SCShareableContent>, Error> {
  let (tx, rx) = mpsc::sync_channel::<Result<Content, Error>>(1);
  let tx = Mutex::new(Some(tx));
  let block = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
    let result = match unsafe { Retained::retain(content) } {
      Some(content) => Ok(Content(content)),
      None => Err(match unsafe { error.as_ref() } {
        Some(error) => ns_error("shareable content", error),
        None => Error::Failed("shareable content: no content and no error".into()),
      }),
    };
    if let Some(tx) = tx.lock().ok().and_then(|mut tx| tx.take()) {
      let _ = tx.send(result);
    }
  });
  unsafe {
    SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
      true, true, &block,
    )
  };
  match rx.recv_timeout(Duration::from_secs(10)) {
    Ok(result) => result.map(|c| c.0),
    Err(_) => Err(Error::Failed("shareable content timed out".into())),
  }
}

type ResponsibleFn = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;

/// libsystem's responsibility_get_pid_responsible_for_pid, which has no public header.
fn responsible_pid(pid: libc::pid_t) -> Option<libc::pid_t> {
  static FUNC: OnceLock<Option<ResponsibleFn>> = OnceLock::new();
  let func = FUNC.get_or_init(|| {
    let sym = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"responsibility_get_pid_responsible_for_pid".as_ptr()) };
    (!sym.is_null()).then(|| unsafe { std::mem::transmute::<*mut c_void, ResponsibleFn>(sym) })
  });
  func.map(|f| unsafe { f(pid) })
}

fn is_own(app: &SCRunningApplication, own: libc::pid_t) -> bool {
  let pid = unsafe { app.processID() };
  pid == own || responsible_pid(pid) == Some(own)
}

fn window_app(windows: &NSArray<SCWindow>, matches: impl Fn(&SCWindow) -> bool) -> Option<Retained<SCRunningApplication>> {
  let mut found: Option<Retained<SCRunningApplication>> = None;
  for window in windows.iter() {
    if !matches(&window) {
      continue;
    }
    let app = unsafe { window.owningApplication() }?;
    match &found {
      Some(prev) if unsafe { prev.processID() != app.processID() } => return None,
      Some(_) => {}
      None => found = Some(app),
    }
  }
  found
}

enum Resolved {
  App(Retained<SCRunningApplication>, String),
  System(String),
}

fn resolve(content: &SCShareableContent, target: &Target, own: libc::pid_t) -> Resolved {
  let windows = unsafe { content.windows() };
  let app = match target {
    Target::System => return Resolved::System("system: every application but this one".into()),
    Target::Window(WindowRef::Id(id)) => window_app(&windows, |w| unsafe { w.windowID() } as u64 == *id),
    Target::Window(WindowRef::Title(title)) => {
      window_app(&windows, |w| unsafe { w.title() }.is_some_and(|t| t.to_string() == *title)).or_else(|| {
        let apps = unsafe { content.applications() };
        let named: Vec<_> = apps.iter().filter(|a| unsafe { a.applicationName() }.to_string() == *title).collect();
        match <[_; 1]>::try_from(named) {
          Ok([only]) => Some(only),
          Err(_) => None,
        }
      })
    }
  };
  match app {
    Some(app) if !is_own(&app, own) => {
      let name = unsafe { app.applicationName() }.to_string();
      let detail = format!("app: pid {} ({name}) from {target:?}", unsafe { app.processID() });
      Resolved::App(app, detail)
    }
    Some(_) => Resolved::System(format!("system: {target:?} belongs to this application")),
    None => Resolved::System(format!("system: {target:?} matches no single application")),
  }
}

struct OutputIvars {
  sink: Mutex<Sink>,
  scratch: Mutex<Vec<i16>>,
  stopped: AtomicBool,
}

define_class!(
  #[unsafe(super(NSObject))]
  #[name = "HarmonyStreamAudioOutput"]
  #[ivars = OutputIvars]
  struct AudioOutput;

  unsafe impl NSObjectProtocol for AudioOutput {}

  unsafe impl SCStreamOutput for AudioOutput {
    #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
    fn stream_did_output(&self, _stream: &SCStream, sample_buffer: &CMSampleBuffer, kind: SCStreamOutputType) {
      if kind == SCStreamOutputType::Audio && !self.ivars().stopped.load(Ordering::Relaxed) {
        self.deliver(sample_buffer);
      }
    }
  }
);

impl AudioOutput {
  fn new(sink: Sink) -> Retained<Self> {
    let this = Self::alloc().set_ivars(OutputIvars {
      sink: Mutex::new(sink),
      scratch: Mutex::new(Vec::new()),
      stopped: AtomicBool::new(false),
    });
    unsafe { msg_send![super(this), init] }
  }

  fn deliver(&self, sample_buffer: &CMSampleBuffer) {
    let Some(format) = (unsafe { sample_buffer.format_description() }) else { return };
    let Some(asbd) = (unsafe { CMAudioFormatDescriptionGetStreamBasicDescription(&format).as_ref() }) else { return };
    if asbd.mFormatID != kAudioFormatLinearPCM
      || asbd.mFormatFlags & kAudioFormatFlagIsFloat == 0
      || asbd.mBitsPerChannel != 32
      || asbd.mChannelsPerFrame == 0
    {
      return;
    }
    let channels = asbd.mChannelsPerFrame as usize;
    let planar = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0;

    // AudioBufferList with room for 8 buffers; the stream is configured for 2 channels.
    let mut storage = [0u64; 1 + 8 * 2];
    let list = storage.as_mut_ptr() as *mut AudioBufferList;
    let mut block: *mut CMBlockBuffer = std::ptr::null_mut();
    let status = unsafe {
      sample_buffer.audio_buffer_list_with_retained_block_buffer(
        std::ptr::null_mut(),
        list,
        std::mem::size_of_val(&storage),
        None,
        None,
        kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
        &mut block,
      )
    };
    if status != 0 {
      return;
    }
    // The list points into the block buffer, retained here until the copy below is done.
    let _block = NonNull::new(block).map(|b| unsafe { CFRetained::from_raw(b) });
    let buffers: &[AudioBuffer] =
      unsafe { std::slice::from_raw_parts((*list).mBuffers.as_ptr(), (*list).mNumberBuffers as usize) };
    let Some(first) = buffers.first() else { return };
    if first.mData.is_null() {
      return;
    }

    let channel = |c: usize| -> &[f32] {
      let b = &buffers[c.min(buffers.len() - 1)];
      unsafe { std::slice::from_raw_parts(b.mData as *const f32, b.mDataByteSize as usize / 4) }
    };
    // Frame i: left at left[i * stride], right at right[i * stride + right_offset]. Mono
    // duplicates its one channel.
    let second = if channels > 1 { 1 } else { 0 };
    let (frames, left, right, stride, right_offset) = if planar {
      let (l, r) = (channel(0), channel(second));
      (l.len().min(r.len()), l, r, 1, 0)
    } else {
      let data = channel(0);
      (data.len() / channels, data, data, channels, second)
    };

    let Ok(mut scratch) = self.ivars().scratch.lock() else { return };
    scratch.clear();
    scratch.reserve(frames * CHANNELS);
    for i in 0..frames {
      scratch.push(f32_to_i16(left[i * stride]));
      scratch.push(f32_to_i16(right[i * stride + right_offset]));
    }
    if let Ok(mut sink) = self.ivars().sink.lock() {
      sink(&scratch);
    }
  }
}

pub struct Capture {
  stream: Retained<SCStream>,
  output: Retained<AudioOutput>,
  _queue: DispatchRetained<DispatchQueue>,
}

// SAFETY: SCStream's start and stop may be called from any thread; the output object is only
// read through its Mutex/atomic ivars.
unsafe impl Send for Capture {}

impl Drop for Capture {
  fn drop(&mut self) {
    self.output.ivars().stopped.store(true, Ordering::Relaxed);
    let (tx, rx) = mpsc::sync_channel::<()>(1);
    let tx = Mutex::new(Some(tx));
    let done = RcBlock::new(move |_error: *mut NSError| {
      if let Some(tx) = tx.lock().ok().and_then(|mut tx| tx.take()) {
        let _ = tx.send(());
      }
    });
    unsafe { self.stream.stopCaptureWithCompletionHandler(Some(&done)) };
    let _ = rx.recv_timeout(Duration::from_secs(2));
  }
}

fn start_stream(stream: &SCStream) -> Result<(), Error> {
  let (tx, rx) = mpsc::sync_channel::<Result<(), Error>>(1);
  let tx = Mutex::new(Some(tx));
  let done = RcBlock::new(move |error: *mut NSError| {
    let result = match unsafe { error.as_ref() } {
      Some(error) => Err(ns_error("start capture", error)),
      None => Ok(()),
    };
    if let Some(tx) = tx.lock().ok().and_then(|mut tx| tx.take()) {
      let _ = tx.send(result);
    }
  });
  unsafe { stream.startCaptureWithCompletionHandler(Some(&done)) };
  rx.recv_timeout(Duration::from_secs(10)).unwrap_or_else(|_| Err(Error::Failed("start capture timed out".into())))
}

pub fn start(target: Target, sink: Sink) -> Result<(Capture, Started), Error> {
  support()?;
  let content = shareable_content()?;
  let own = std::process::id() as libc::pid_t;
  let display = unsafe { content.displays() }
    .firstObject()
    .ok_or_else(|| Error::Failed("no display to anchor the content filter".into()))?;
  let none: Retained<NSArray<SCWindow>> = NSArray::new();

  let (filter, started) = match resolve(&content, &target, own) {
    Resolved::App(app, detail) => {
      let name = unsafe { app.applicationName() }.to_string();
      let apps = NSArray::from_retained_slice(&[app]);
      let filter = unsafe {
        SCContentFilter::initWithDisplay_includingApplications_exceptingWindows(
          SCContentFilter::alloc(),
          &display,
          &apps,
          &none,
        )
      };
      (filter, Started { scope: Scope::App, app: Some(name), detail })
    }
    Resolved::System(detail) => {
      let own_apps: Vec<Retained<SCRunningApplication>> =
        unsafe { content.applications() }.iter().filter(|a| is_own(a, own)).collect();
      let apps = NSArray::from_retained_slice(&own_apps);
      let filter = unsafe {
        SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(
          SCContentFilter::alloc(),
          &display,
          &apps,
          &none,
        )
      };
      (filter, Started { scope: Scope::System, app: None, detail })
    }
  };

  let config = unsafe { SCStreamConfiguration::new() };
  unsafe {
    config.setCapturesAudio(true);
    config.setExcludesCurrentProcessAudio(true);
    config.setSampleRate(SAMPLE_RATE as isize);
    config.setChannelCount(CHANNELS as isize);
    config.setWidth(2);
    config.setHeight(2);
    config.setMinimumFrameInterval(CMTime::new(1, 1));
  }

  let stream = unsafe { SCStream::initWithFilter_configuration_delegate(SCStream::alloc(), &filter, &config, None) };
  let output = AudioOutput::new(sink);
  let queue = DispatchQueue::new("online.knowmad.harmony.stream-audio", None);
  unsafe {
    stream.addStreamOutput_type_sampleHandlerQueue_error(
      ProtocolObject::from_ref(&*output),
      SCStreamOutputType::Audio,
      Some(&queue),
    )
  }
  .map_err(|e| ns_error("add audio output", &e))?;
  start_stream(&stream)?;
  Ok((Capture { stream, output, _queue: queue }, started))
}
