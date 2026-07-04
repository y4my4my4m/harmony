use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use livekit::webrtc::desktop_capturer::{
  CaptureError, DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions, DesktopFrame,
};
use livekit::webrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::VideoResolution;

use crate::camera::write_planes;
use crate::video::{rgb_to_i420, FrameStore, TileKey, LOCAL_USER};

pub struct ScreenCapture {
  stop: Arc<AtomicBool>,
  pub source: NativeVideoSource,
}

impl ScreenCapture {
  /// Captures via libwebrtc's DesktopCapturer (PipeWire portal on Wayland,
  /// X11 otherwise). Poll-driven: we request frames at `fps` and forward
  /// them to the publish source + local preview tile.
  pub fn start(fps: u32, frames: FrameStore) -> Result<Self, String> {
    let fps = fps.clamp(5, 60);
    let mut options = DesktopCapturerOptions::new(DesktopCaptureSourceType::Screen);
    options.set_include_cursor(true);

    let mut capturer =
      DesktopCapturer::new(options).ok_or_else(|| "desktop capturer unavailable".to_string())?;

    let source = NativeVideoSource::new(VideoResolution { width: 1920, height: 1080 }, true);
    let stop = Arc::new(AtomicBool::new(false));

    // pick the first screen when a source list is available; portal-backed
    // capture (Wayland) shows the system picker instead
    let capture_source = capturer.get_source_list().into_iter().next();

    let cb_source = source.clone();
    let cb_frames = frames.clone();
    let key = TileKey { user_id: LOCAL_USER.to_string(), is_screen: true };
    let cb_key = key.clone();

    capturer.start_capture(capture_source, move |result: Result<DesktopFrame, CaptureError>| {
      let frame = match result {
        Ok(frame) => frame,
        Err(e) => {
          log::warn!("screen capture frame error: {e:?}");
          return;
        }
      };
      let (w, h) = (frame.width() as u32, frame.height() as u32);
      if w == 0 || h == 0 {
        return;
      }
      // DesktopFrame is BGRA
      let owned = rgb_to_i420(frame.data(), w, h, frame.stride(), 4, 2, 1, 0);

      let mut buffer = I420Buffer::new(w, h);
      write_planes(&mut buffer, &owned.y, &owned.u, &owned.v);
      cb_source.capture_frame(&VideoFrame::new(VideoRotation::VideoRotation0, buffer));
      cb_frames.put(cb_key.clone(), owned);
    });

    let thread_stop = stop.clone();
    std::thread::Builder::new()
      .name("screen-capture".into())
      .spawn(move || {
        let interval = std::time::Duration::from_micros(1_000_000 / fps as u64);
        while !thread_stop.load(Ordering::Relaxed) {
          capturer.capture_frame();
          std::thread::sleep(interval);
        }
        frames.remove(&key);
        drop(capturer);
      })
      .map_err(|e| e.to_string())?;

    Ok(Self { stop, source })
  }

  pub fn stop(&self) {
    self.stop.store(true, Ordering::Relaxed);
  }
}

impl Drop for ScreenCapture {
  fn drop(&mut self) {
    self.stop();
  }
}
