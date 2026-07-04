// Native call window: video tiles rendered with wgpu into a webview-less
// tauri window (feature "unstable"). WebKitGTK has no WebRTC, so remote
// frames decoded by the Rust media engine are displayed here instead of in
// the webview — the Discord "popped-out call" model.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use harmony_media::{FrameStore, OwnedVideoFrame, TileKey};
use tauri::{AppHandle, Manager, WindowEvent};

const WINDOW_LABEL: &str = "call";

#[derive(Default)]
pub struct CallWindowState {
  stop: Mutex<Option<Arc<AtomicBool>>>,
}

pub fn open(app: &AppHandle, frames: FrameStore) -> Result<(), String> {
  if let Some(window) = app.get_window(WINDOW_LABEL) {
    let _ = window.set_focus();
    return Ok(());
  }

  let window = tauri::window::WindowBuilder::new(app, WINDOW_LABEL)
    .title("Harmony — Call")
    .inner_size(960.0, 540.0)
    .min_inner_size(320.0, 180.0)
    .build()
    .map_err(|e| format!("call window: {e}"))?;

  let stop = Arc::new(AtomicBool::new(false));

  let event_stop = stop.clone();
  window.on_window_event(move |event| {
    if matches!(event, WindowEvent::Destroyed | WindowEvent::CloseRequested { .. }) {
      event_stop.store(true, Ordering::Relaxed);
    }
  });

  {
    let state = app.state::<CallWindowState>();
    let previous = state.stop.lock().unwrap().replace(stop.clone());
    if let Some(previous) = previous {
      previous.store(true, Ordering::Relaxed);
    }
  }

  let render_window = window.clone();
  std::thread::Builder::new()
    .name("call-render".into())
    .spawn(move || {
      if let Err(e) = render_loop(render_window, frames, stop) {
        log::error!("call window render loop: {e}");
      }
    })
    .map_err(|e| e.to_string())?;

  Ok(())
}

pub fn close(app: &AppHandle) {
  let state = app.state::<CallWindowState>();
  if let Some(stop) = state.stop.lock().unwrap().take() {
    stop.store(true, Ordering::Relaxed);
  }
  if let Some(window) = app.get_window(WINDOW_LABEL) {
    let _ = window.close();
  }
}

struct TileTextures {
  width: u32,
  height: u32,
  y: wgpu::Texture,
  u: wgpu::Texture,
  v: wgpu::Texture,
  bind_group: wgpu::BindGroup,
}

fn render_loop(
  window: tauri::Window,
  frames: FrameStore,
  stop: Arc<AtomicBool>,
) -> Result<(), String> {
  let instance = wgpu::Instance::default();
  let surface = instance
    .create_surface(window.clone())
    .map_err(|e| format!("surface: {e}"))?;

  let adapter = pollster_block(instance.request_adapter(&wgpu::RequestAdapterOptions {
    power_preference: wgpu::PowerPreference::LowPower,
    compatible_surface: Some(&surface),
    ..Default::default()
  }))
  .map_err(|e| format!("adapter: {e}"))?;

  let (device, queue) = pollster_block(adapter.request_device(&wgpu::DeviceDescriptor::default()))
    .map_err(|e| format!("device: {e}"))?;

  let caps = surface.get_capabilities(&adapter);
  let format = caps
    .formats
    .iter()
    .copied()
    .find(|f| !f.is_srgb())
    .unwrap_or(caps.formats[0]);

  let mut size = window.inner_size().map_err(|e| e.to_string())?;
  let mut config = wgpu::SurfaceConfiguration {
    usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
    format,
    width: size.width.max(1),
    height: size.height.max(1),
    present_mode: wgpu::PresentMode::Fifo,
    color_space: Default::default(),
    alpha_mode: caps.alpha_modes[0],
    view_formats: vec![],
    desired_maximum_frame_latency: 2,
  };
  surface.configure(&device, &config);

  let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
    label: Some("yuv-tile"),
    source: wgpu::ShaderSource::Wgsl(SHADER.into()),
  });

  let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
    label: Some("yuv-planes"),
    entries: &[
      plane_entry(0),
      plane_entry(1),
      plane_entry(2),
      wgpu::BindGroupLayoutEntry {
        binding: 3,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
        count: None,
      },
    ],
  });

  let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
    label: None,
    bind_group_layouts: &[Some(&bind_layout)],
    immediate_size: 0,
  });

  let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
    label: Some("yuv-tile"),
    layout: Some(&pipeline_layout),
    vertex: wgpu::VertexState {
      module: &shader,
      entry_point: Some("vs_main"),
      buffers: &[],
      compilation_options: Default::default(),
    },
    fragment: Some(wgpu::FragmentState {
      module: &shader,
      entry_point: Some("fs_main"),
      targets: &[Some(wgpu::ColorTargetState {
        format,
        blend: None,
        write_mask: wgpu::ColorWrites::ALL,
      })],
      compilation_options: Default::default(),
    }),
    primitive: wgpu::PrimitiveState {
      topology: wgpu::PrimitiveTopology::TriangleStrip,
      ..Default::default()
    },
    depth_stencil: None,
    multisample: wgpu::MultisampleState::default(),
    multiview_mask: None,
    cache: None,
  });

  let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
    mag_filter: wgpu::FilterMode::Linear,
    min_filter: wgpu::FilterMode::Linear,
    ..Default::default()
  });

  let mut tiles: std::collections::HashMap<TileKey, TileTextures> = Default::default();
  let mut last_version = u64::MAX;

  while !stop.load(Ordering::Relaxed) {
    let Ok(current) = window.inner_size() else { break };
    let resized = current != size;
    if resized {
      size = current;
      config.width = size.width.max(1);
      config.height = size.height.max(1);
      surface.configure(&device, &config);
    }

    let version = frames.version();
    if version == last_version && !resized {
      std::thread::sleep(std::time::Duration::from_millis(8));
      continue;
    }
    last_version = version;

    let snapshot = frames.snapshot();
    tiles.retain(|key, _| snapshot.iter().any(|(k, _)| k == key));

    for (key, frame) in &snapshot {
      let entry = tiles.get(key);
      if entry.map(|t| (t.width, t.height)) != Some((frame.width, frame.height)) {
        tiles.insert(
          key.clone(),
          create_tile(&device, &bind_layout, &sampler, frame.width, frame.height),
        );
      }
      upload_tile(&queue, tiles.get(key).unwrap(), frame);
    }

    use wgpu::CurrentSurfaceTexture as Cst;
    let frame_tex = match surface.get_current_texture() {
      Cst::Success(t) | Cst::Suboptimal(t) => t,
      Cst::Outdated | Cst::Lost => {
        surface.configure(&device, &config);
        last_version = u64::MAX;
        continue;
      }
      Cst::Timeout | Cst::Occluded | Cst::Validation => {
        last_version = u64::MAX;
        std::thread::sleep(std::time::Duration::from_millis(50));
        continue;
      }
    };
    let view = frame_tex.texture.create_view(&Default::default());

    let mut encoder = device.create_command_encoder(&Default::default());
    {
      let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("tiles"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
          view: &view,
          resolve_target: None,
          ops: wgpu::Operations {
            load: wgpu::LoadOp::Clear(wgpu::Color {
              r: 0.05,
              g: 0.05,
              b: 0.07,
              a: 1.0,
            }),
            store: wgpu::StoreOp::Store,
          },
          depth_slice: None,
        })],
        ..Default::default()
      });

      pass.set_pipeline(&pipeline);

      let count = snapshot.len().max(1);
      let cols = (count as f32).sqrt().ceil() as usize;
      let rows = count.div_ceil(cols);
      let cell_w = config.width as f32 / cols as f32;
      let cell_h = config.height as f32 / rows as f32;

      for (i, (key, frame)) in snapshot.iter().enumerate() {
        if !tiles.contains_key(key) {
          continue;
        }
        let col = i % cols;
        let row = i / cols;

        // letterbox inside the cell, preserving frame aspect
        let scale =
          (cell_w / frame.width as f32).min(cell_h / frame.height as f32);
        let w = frame.width as f32 * scale;
        let h = frame.height as f32 * scale;
        let x = col as f32 * cell_w + (cell_w - w) / 2.0;
        let y = row as f32 * cell_h + (cell_h - h) / 2.0;

        if w < 1.0 || h < 1.0 {
          continue;
        }
        pass.set_viewport(x, y, w, h, 0.0, 1.0);
        pass.set_bind_group(0, &tiles.get(key).unwrap().bind_group, &[]);
        pass.draw(0..4, 0..1);
      }
    }

    queue.submit([encoder.finish()]);
    queue.present(frame_tex);
  }

  Ok(())
}

fn plane_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
  wgpu::BindGroupLayoutEntry {
    binding,
    visibility: wgpu::ShaderStages::FRAGMENT,
    ty: wgpu::BindingType::Texture {
      sample_type: wgpu::TextureSampleType::Float { filterable: true },
      view_dimension: wgpu::TextureViewDimension::D2,
      multisampled: false,
    },
    count: None,
  }
}

fn create_tile(
  device: &wgpu::Device,
  layout: &wgpu::BindGroupLayout,
  sampler: &wgpu::Sampler,
  width: u32,
  height: u32,
) -> TileTextures {
  let plane = |w: u32, h: u32| {
    device.create_texture(&wgpu::TextureDescriptor {
      label: None,
      size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 },
      mip_level_count: 1,
      sample_count: 1,
      dimension: wgpu::TextureDimension::D2,
      format: wgpu::TextureFormat::R8Unorm,
      usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
      view_formats: &[],
    })
  };

  let cw = width.div_ceil(2);
  let ch = height.div_ceil(2);
  let y = plane(width, height);
  let u = plane(cw, ch);
  let v = plane(cw, ch);

  let view = |t: &wgpu::Texture| t.create_view(&Default::default());
  let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
    label: None,
    layout,
    entries: &[
      wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view(&y)) },
      wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&view(&u)) },
      wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&view(&v)) },
      wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(sampler) },
    ],
  });

  TileTextures { width, height, y, u, v, bind_group }
}

fn upload_tile(queue: &wgpu::Queue, tile: &TileTextures, frame: &OwnedVideoFrame) {
  let cw = frame.width.div_ceil(2);
  let ch = frame.height.div_ceil(2);
  let write = |tex: &wgpu::Texture, data: &[u8], w: u32, h: u32| {
    queue.write_texture(
      wgpu::TexelCopyTextureInfo {
        texture: tex,
        mip_level: 0,
        origin: wgpu::Origin3d::ZERO,
        aspect: wgpu::TextureAspect::All,
      },
      data,
      wgpu::TexelCopyBufferLayout {
        offset: 0,
        bytes_per_row: Some(w),
        rows_per_image: Some(h),
      },
      wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
  };
  write(&tile.y, &frame.y, frame.width, frame.height);
  write(&tile.u, &frame.u, cw, ch);
  write(&tile.v, &frame.v, cw, ch);
}

fn pollster_block<F: std::future::Future>(future: F) -> F::Output {
  // tiny local block_on to avoid a pollster dep; render thread has no runtime
  use std::sync::mpsc;
  use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};

  fn raw_waker(tx: *const mpsc::Sender<()>) -> RawWaker {
    unsafe fn clone(data: *const ()) -> RawWaker {
      raw_waker(data as *const mpsc::Sender<()>)
    }
    unsafe fn wake(data: *const ()) {
      let tx = unsafe { &*(data as *const mpsc::Sender<()>) };
      let _ = tx.send(());
    }
    unsafe fn drop_fn(_data: *const ()) {}
    static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, wake, wake, drop_fn);
    RawWaker::new(tx as *const (), &VTABLE)
  }

  let (tx, rx) = mpsc::channel::<()>();
  let waker = unsafe { Waker::from_raw(raw_waker(&tx)) };
  let mut cx = Context::from_waker(&waker);
  let mut future = std::pin::pin!(future);
  loop {
    match future.as_mut().poll(&mut cx) {
      Poll::Ready(value) => return value,
      Poll::Pending => {
        let _ = rx.recv();
      }
    }
  }
}

const SHADER: &str = r#"
struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var positions = array<vec2<f32>, 4>(
    vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0), vec2(1.0, 1.0)
  );
  var uvs = array<vec2<f32>, 4>(
    vec2(0.0, 1.0), vec2(1.0, 1.0), vec2(0.0, 0.0), vec2(1.0, 0.0)
  );
  var out: VSOut;
  out.pos = vec4(positions[vi], 0.0, 1.0);
  out.uv = uvs[vi];
  return out;
}

@group(0) @binding(0) var tex_y: texture_2d<f32>;
@group(0) @binding(1) var tex_u: texture_2d<f32>;
@group(0) @binding(2) var tex_v: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let y = (textureSample(tex_y, samp, in.uv).r - 0.0625) * 1.164;
  let u = textureSample(tex_u, samp, in.uv).r - 0.5;
  let v = textureSample(tex_v, samp, in.uv).r - 0.5;
  let r = y + 1.596 * v;
  let g = y - 0.392 * u - 0.813 * v;
  let b = y + 2.017 * u;
  return vec4(clamp(vec3(r, g, b), vec3(0.0), vec3(1.0)), 1.0);
}
"#;
