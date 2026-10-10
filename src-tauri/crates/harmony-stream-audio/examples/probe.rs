//! Captures program audio for a few seconds and reports what arrived.
//!
//!   cargo run --example probe [seconds] [window title]
//!
//! Without a title the whole system (every application but this one) is captured; with one,
//! the application owning that window. Something else must play sound meanwhile: this process
//! and its children are excluded. Exit status: 0 audible audio arrived, 1 silence or nothing,
//! 2 capture did not start.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use harmony_stream_audio::{self as audio, Target, WindowRef};

/// -60 dBFS.
const AUDIBLE_PEAK: u16 = 33;

fn main() {
  let mut args = std::env::args().skip(1);
  let seconds: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(6);
  let target = match args.next() {
    Some(title) => Target::Window(WindowRef::Title(title)),
    None => Target::System,
  };
  println!("support: {:?}", audio::support());
  println!("permission: {:?}", audio::permission_granted());
  println!("target: {target:?}");

  // (samples, peak |sample|, sink calls)
  let stats = Arc::new(Mutex::new((0usize, 0u16, 0usize)));
  let shared = Arc::clone(&stats);
  let sink: audio::Sink = Box::new(move |samples: &[i16]| {
    if let Ok(mut s) = shared.lock() {
      s.0 += samples.len();
      s.1 = samples.iter().fold(s.1, |peak, x| peak.max(x.unsigned_abs()));
      s.2 += 1;
    }
  });

  let (capture, started) = match audio::start(target, sink) {
    Ok(ok) => ok,
    Err(e) => {
      println!("start failed: {e}");
      std::process::exit(2);
    }
  };
  println!("started: {:?} app={:?} detail={}", started.scope, started.app, started.detail);
  for second in 1..=seconds {
    std::thread::sleep(Duration::from_secs(1));
    let (samples, peak, calls) = *stats.lock().unwrap();
    println!("t={second}s samples={samples} calls={calls} peak={peak}");
  }
  capture.stop();

  let (samples, peak, _) = *stats.lock().unwrap();
  let frames = samples / audio::CHANNELS;
  let expected = audio::SAMPLE_RATE as usize * seconds as usize;
  println!("frames {frames} of ~{expected} expected, peak {peak} (audible >= {AUDIBLE_PEAK})");
  std::process::exit(if samples > 0 && peak >= AUDIBLE_PEAK { 0 } else { 1 });
}
