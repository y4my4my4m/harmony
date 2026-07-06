use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use livekit::webrtc::video_frame::{I420Buffer, VideoBuffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::VideoResolution;
use nokhwa::pixel_format::RgbFormat;
use nokhwa::utils::{ApiBackend, CameraIndex, RequestedFormat, RequestedFormatType};

use crate::video::{rgb_to_i420, FrameStore, TileKey, LOCAL_USER};

pub struct CameraCapture {
  stop: Arc<AtomicBool>,
  pub source: NativeVideoSource,
}

pub fn list_cameras() -> Vec<(String, String)> {
  nokhwa::query(ApiBackend::Auto)
    .map(|cams| {
      cams
        .into_iter()
        .map(|c| (c.index().to_string(), c.human_name()))
        .collect()
    })
    .unwrap_or_default()
}

impl CameraCapture {
  // camera opened inside the thread: nokhwa handles aren't Send
  pub fn start(device_index: Option<u32>, frames: FrameStore) -> Result<Self, String> {
    let source =
      NativeVideoSource::new(VideoResolution { width: 1280, height: 720 }, false);
    let stop = Arc::new(AtomicBool::new(false));

    let thread_stop = stop.clone();
    let thread_source = source.clone();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    std::thread::Builder::new()
      .name("camera-capture".into())
      .spawn(move || {
        let index = CameraIndex::Index(device_index.unwrap_or(0));
        let format =
          RequestedFormat::new::<RgbFormat>(RequestedFormatType::AbsoluteHighestFrameRate);

        let mut camera = match nokhwa::Camera::new(index, format) {
          Ok(c) => c,
          Err(e) => {
            let _ = ready_tx.send(Err(format!("camera open: {e}")));
            return;
          }
        };
        if let Err(e) = camera.open_stream() {
          let _ = ready_tx.send(Err(format!("camera stream: {e}")));
          return;
        }
        let _ = ready_tx.send(Ok(()));

        let key = TileKey { user_id: LOCAL_USER.to_string(), is_screen: false };
        while !thread_stop.load(Ordering::Relaxed) {
          let frame = match camera.frame() {
            Ok(f) => f,
            Err(e) => {
              log::warn!("camera frame failed: {e}");
              break;
            }
          };
          let decoded = match frame.decode_image::<RgbFormat>() {
            Ok(d) => d,
            Err(e) => {
              log::warn!("camera decode failed: {e}");
              continue;
            }
          };
          let (w, h) = (decoded.width(), decoded.height());
          let rgb = decoded.into_raw();
          let owned = rgb_to_i420(&rgb, w, h, w * 3, 3, 0, 1, 2);

          let mut buffer = I420Buffer::new(w, h);
          write_planes(&mut buffer, &owned.y, &owned.u, &owned.v);
          thread_source.capture_frame(&VideoFrame::new(VideoRotation::VideoRotation0, buffer));

          frames.put(key.clone(), owned);
        }
        frames.remove(&key);
        let _ = camera.stop_stream();
      })
      .map_err(|e| e.to_string())?;

    ready_rx
      .recv()
      .map_err(|_| "camera thread died during startup".to_string())??;

    Ok(Self { stop, source })
  }

  pub fn stop(&self) {
    self.stop.store(true, Ordering::Relaxed);
  }
}

impl Drop for CameraCapture {
  fn drop(&mut self) {
    self.stop();
  }
}

pub(crate) fn write_planes(buffer: &mut I420Buffer, y: &[u8], u: &[u8], v: &[u8]) {
  let (stride_y, stride_u, stride_v) = buffer.strides();
  let width = buffer.width() as usize;
  let height = buffer.height() as usize;
  let chroma_w = buffer.chroma_width() as usize;
  let chroma_h = buffer.chroma_height() as usize;
  let (dy, du, dv) = buffer.data_mut();

  for row in 0..height {
    dy[row * stride_y as usize..row * stride_y as usize + width]
      .copy_from_slice(&y[row * width..(row + 1) * width]);
  }
  for row in 0..chroma_h {
    du[row * stride_u as usize..row * stride_u as usize + chroma_w]
      .copy_from_slice(&u[row * chroma_w..(row + 1) * chroma_w]);
    dv[row * stride_v as usize..row * stride_v as usize + chroma_w]
      .copy_from_slice(&v[row * chroma_w..(row + 1) * chroma_w]);
  }
}
