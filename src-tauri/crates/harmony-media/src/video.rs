use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub const LOCAL_USER: &str = "local";

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TileKey {
  pub user_id: String,
  pub is_screen: bool,
}

// tightly packed: stride == width for Y, width/2 for U/V
pub struct OwnedVideoFrame {
  pub width: u32,
  pub height: u32,
  pub y: Vec<u8>,
  pub u: Vec<u8>,
  pub v: Vec<u8>,
}

// latest-frame-wins; render loop polls `version` to skip redundant redraws
#[derive(Clone, Default)]
pub struct FrameStore {
  inner: Arc<FrameStoreInner>,
}

#[derive(Default)]
struct FrameStoreInner {
  frames: Mutex<HashMap<TileKey, OwnedVideoFrame>>,
  version: AtomicU64,
}

impl FrameStore {
  pub fn put(&self, key: TileKey, frame: OwnedVideoFrame) {
    self.inner.frames.lock().unwrap().insert(key, frame);
    self.inner.version.fetch_add(1, Ordering::Release);
  }

  pub fn remove(&self, key: &TileKey) {
    self.inner.frames.lock().unwrap().remove(key);
    self.inner.version.fetch_add(1, Ordering::Release);
  }

  pub fn remove_user(&self, user_id: &str) {
    self.inner.frames.lock().unwrap().retain(|k, _| k.user_id != user_id);
    self.inner.version.fetch_add(1, Ordering::Release);
  }

  pub fn clear(&self) {
    self.inner.frames.lock().unwrap().clear();
    self.inner.version.fetch_add(1, Ordering::Release);
  }

  pub fn version(&self) -> u64 {
    self.inner.version.load(Ordering::Acquire)
  }

  pub fn snapshot(&self) -> Vec<(TileKey, OwnedVideoFrame)> {
    let frames = self.inner.frames.lock().unwrap();
    let mut tiles: Vec<(TileKey, OwnedVideoFrame)> = frames
      .iter()
      .map(|(k, f)| {
        (
          k.clone(),
          OwnedVideoFrame {
            width: f.width,
            height: f.height,
            y: f.y.clone(),
            u: f.u.clone(),
            v: f.v.clone(),
          },
        )
      })
      .collect();
    tiles.sort_by(|a, b| a.0.cmp(&b.0));
    tiles
  }
}

pub fn pack_i420(
  width: u32,
  height: u32,
  y: &[u8],
  stride_y: u32,
  u: &[u8],
  stride_u: u32,
  v: &[u8],
  stride_v: u32,
) -> OwnedVideoFrame {
  let cw = width.div_ceil(2) as usize;
  let ch = height.div_ceil(2) as usize;
  let (w, h) = (width as usize, height as usize);

  let mut py = vec![0u8; w * h];
  let mut pu = vec![0u8; cw * ch];
  let mut pv = vec![0u8; cw * ch];

  for row in 0..h {
    let src = row * stride_y as usize;
    py[row * w..(row + 1) * w].copy_from_slice(&y[src..src + w]);
  }
  for row in 0..ch {
    let su = row * stride_u as usize;
    let sv = row * stride_v as usize;
    pu[row * cw..(row + 1) * cw].copy_from_slice(&u[su..su + cw]);
    pv[row * cw..(row + 1) * cw].copy_from_slice(&v[sv..sv + cw]);
  }

  OwnedVideoFrame { width, height, y: py, u: pu, v: pv }
}

// BT.601 limited-range. step = bytes/pixel; ro/go/bo = channel offsets (BGRA: 4,2,1,0)
pub fn rgb_to_i420(
  data: &[u8],
  width: u32,
  height: u32,
  stride: u32,
  step: usize,
  ro: usize,
  go: usize,
  bo: usize,
) -> OwnedVideoFrame {
  let (w, h) = (width as usize, height as usize);
  let cw = width.div_ceil(2) as usize;
  let ch = height.div_ceil(2) as usize;

  let mut y = vec![0u8; w * h];
  let mut u = vec![128u8; cw * ch];
  let mut v = vec![128u8; cw * ch];

  let px = |row: usize, col: usize| -> (i32, i32, i32) {
    let o = row * stride as usize + col * step;
    (data[o + ro] as i32, data[o + go] as i32, data[o + bo] as i32)
  };

  for row in 0..h {
    for col in 0..w {
      let (r, g, b) = px(row, col);
      y[row * w + col] = (((66 * r + 129 * g + 25 * b + 128) >> 8) + 16).clamp(0, 255) as u8;
    }
  }

  for crow in 0..ch {
    for ccol in 0..cw {
      let (mut sr, mut sg, mut sb, mut n) = (0i32, 0i32, 0i32, 0i32);
      for dy in 0..2usize {
        for dx in 0..2usize {
          let row = (crow * 2 + dy).min(h - 1);
          let col = (ccol * 2 + dx).min(w - 1);
          let (r, g, b) = px(row, col);
          sr += r;
          sg += g;
          sb += b;
          n += 1;
        }
      }
      let (r, g, b) = (sr / n, sg / n, sb / n);
      u[crow * cw + ccol] = (((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128).clamp(0, 255) as u8;
      v[crow * cw + ccol] = (((112 * r - 94 * g - 18 * b + 128) >> 8) + 128).clamp(0, 255) as u8;
    }
  }

  OwnedVideoFrame { width, height, y, u, v }
}
