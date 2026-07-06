use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use livekit::webrtc::desktop_capturer::{
  CaptureError, DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions, DesktopFrame,
};
use livekit::webrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::VideoResolution;
use serde::{Deserialize, Serialize};

use crate::camera::write_planes;
use crate::video::{rgb_to_i420, FrameStore, TileKey, LOCAL_USER};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenSource {
  pub id: u64,
  pub title: String,
  #[serde(default)]
  pub is_window: bool,
}

// empty on Wayland: the portal shows its own picker at capture start
pub fn list_screen_sources() -> Vec<ScreenSource> {
  let mut sources = Vec::new();
  for (source_type, is_window) in
    [(DesktopCaptureSourceType::Screen, false), (DesktopCaptureSourceType::Window, true)]
  {
    let options = DesktopCapturerOptions::new(source_type);
    if let Some(capturer) = DesktopCapturer::new(options) {
      for s in capturer.get_source_list() {
        sources.push(ScreenSource { id: s.id(), title: s.title(), is_window });
      }
    }
  }
  sources
}

// one-shot low-res preview for the source picker; returns a JPEG data URL.
// standalone (no Room), so it runs off the media actor.
pub fn capture_thumbnail(source: ScreenSource) -> Option<String> {
  let source_type = if source.is_window {
    DesktopCaptureSourceType::Window
  } else {
    DesktopCaptureSourceType::Screen
  };
  let mut options = DesktopCapturerOptions::new(source_type);
  options.set_include_cursor(false);
  let mut capturer = DesktopCapturer::new(options)?;
  let target = capturer.get_source_list().into_iter().find(|c| c.id() == source.id);

  let (tx, rx) = mpsc::channel::<(u32, u32, u32, Vec<u8>)>();
  capturer.start_capture(target, move |result: Result<DesktopFrame, CaptureError>| {
    if let Ok(frame) = result {
      let (w, h) = (frame.width() as u32, frame.height() as u32);
      if w > 0 && h > 0 {
        let _ = tx.send((w, h, frame.stride(), frame.data().to_vec()));
      }
    }
  });

  // X11 may need a few pumps before the first frame lands
  let mut captured = None;
  for _ in 0..12 {
    capturer.capture_frame();
    if let Ok(frame) = rx.recv_timeout(Duration::from_millis(40)) {
      captured = Some(frame);
      break;
    }
  }
  drop(capturer);
  let (w, h, stride, data) = captured?;

  // BGRA -> RGB, then downscale to a thumbnail
  let mut rgb = image::RgbImage::new(w, h);
  for y in 0..h as usize {
    for x in 0..w as usize {
      let o = y * stride as usize + x * 4;
      rgb.put_pixel(x as u32, y as u32, image::Rgb([data[o + 2], data[o + 1], data[o]]));
    }
  }
  let thumb = image::imageops::resize(&rgb, 256, 256 * h / w.max(1), image::imageops::FilterType::Triangle);

  let mut jpeg = Vec::new();
  image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 70)
    .encode_image(&thumb)
    .ok()?;
  Some(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(&jpeg)))
}

pub struct ScreenCapture {
  stop: Arc<AtomicBool>,
  pub source: NativeVideoSource,
}

impl ScreenCapture {
  pub fn start(
    fps: u32,
    source: Option<ScreenSource>,
    frames: FrameStore,
  ) -> Result<Self, String> {
    let fps = fps.clamp(5, 60);
    let source_type = match &source {
      Some(s) if s.is_window => DesktopCaptureSourceType::Window,
      _ => DesktopCaptureSourceType::Screen,
    };
    let mut options = DesktopCapturerOptions::new(source_type);
    options.set_include_cursor(true);

    let mut capturer =
      DesktopCapturer::new(options).ok_or_else(|| "desktop capturer unavailable".to_string())?;

    let out = NativeVideoSource::new(VideoResolution { width: 1920, height: 1080 }, true);
    let stop = Arc::new(AtomicBool::new(false));

    // Wayland returns an empty list and shows the portal picker at start
    let list = capturer.get_source_list();
    let capture_source = match &source {
      Some(s) => list.into_iter().find(|c| c.id() == s.id),
      None => list.into_iter().next(),
    };

    let cb_source = out.clone();
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

    Ok(Self { stop, source: out })
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
