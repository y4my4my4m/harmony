use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use futures_util::StreamExt;
use livekit::options::TrackPublishOptions;
use livekit::prelude::*;
use livekit::webrtc::video_frame::VideoBuffer;
use livekit::webrtc::video_source::RtcVideoSource;
use livekit::webrtc::video_stream::native::NativeVideoStream;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};

use crate::audio_devices;
use crate::camera::{list_cameras, CameraCapture};
use crate::events::{AudioLevel, MediaEvent, UserMediaState};
use crate::screencast::{list_screen_sources, ScreenCapture, ScreenSource};
use crate::video::{pack_i420, FrameStore, TileKey};

pub type EventSink = Arc<dyn Fn(MediaEvent) + Send + Sync>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
  pub id: String,
  pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceList {
  pub inputs: Vec<DeviceInfo>,
  pub outputs: Vec<DeviceInfo>,
  pub cameras: Vec<DeviceInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineSnapshot {
  pub connected: bool,
  pub local: Option<UserMediaState>,
  pub users: Vec<UserMediaState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VolumeSource {
  Mic,
  Screen,
}

enum Command {
  Connect {
    ws_url: String,
    token: String,
    channel_id: String,
    user_id: String,
    reply: oneshot::Sender<Result<(), String>>,
  },
  Disconnect {
    reply: oneshot::Sender<()>,
  },
  GetState {
    reply: oneshot::Sender<EngineSnapshot>,
  },
  SetMuted {
    muted: bool,
    reply: oneshot::Sender<bool>,
  },
  SetDeafened {
    deafened: bool,
    reply: oneshot::Sender<bool>,
  },
  ListDevices {
    reply: oneshot::Sender<Result<DeviceList, String>>,
  },
  SetInputDevice {
    device_id: String,
    reply: oneshot::Sender<Result<(), String>>,
  },
  SetOutputDevice {
    device_id: String,
    reply: oneshot::Sender<Result<(), String>>,
  },
  SetUserVolume {
    user_id: String,
    source: VolumeSource,
    volume: u16,
    reply: oneshot::Sender<Result<(), String>>,
  },
  Broadcast {
    payload: String,
    topic: Option<String>,
    reply: oneshot::Sender<Result<(), String>>,
  },
  EnableCamera {
    enabled: bool,
    reply: oneshot::Sender<Result<bool, String>>,
  },
  SetScreenshare {
    enabled: bool,
    fps: Option<u32>,
    source: Option<ScreenSource>,
    reply: oneshot::Sender<Result<bool, String>>,
  },
  SetVideoDevice {
    device_id: String,
    reply: oneshot::Sender<Result<(), String>>,
  },
  ListScreenSources {
    reply: oneshot::Sender<Vec<ScreenSource>>,
  },
}

// identity is a synthetic federated id; real profile UUID is in metadata.profileId
fn metadata_profile_id(metadata: &str) -> Option<String> {
  serde_json::from_str::<serde_json::Value>(metadata)
    .ok()?
    .get("profileId")?
    .as_str()
    .map(str::to_string)
}

fn remote_user_id(p: &RemoteParticipant) -> String {
  metadata_profile_id(&p.metadata()).unwrap_or_else(|| p.identity().to_string())
}

fn participant_user_id(p: &Participant) -> String {
  let (metadata, identity) = match p {
    Participant::Local(p) => (p.metadata(), p.identity().to_string()),
    Participant::Remote(p) => (p.metadata(), p.identity().to_string()),
  };
  metadata_profile_id(&metadata).unwrap_or(identity)
}

pub struct MediaEngine {
  tx: mpsc::Sender<Command>,
  frames: FrameStore,
}

impl MediaEngine {
  pub fn new(sink: EventSink) -> Self {
    let (tx, rx) = mpsc::channel(64);
    let frames = FrameStore::default();
    let actor_frames = frames.clone();
    std::thread::Builder::new()
      .name("harmony-media".into())
      .spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
          .worker_threads(2)
          .enable_all()
          .build()
          .expect("media runtime");
        rt.block_on(actor_loop(rx, sink, actor_frames));
      })
      .expect("spawn media thread");
    Self { tx, frames }
  }

  pub fn frames(&self) -> FrameStore {
    self.frames.clone()
  }

  async fn send<T>(&self, make: impl FnOnce(oneshot::Sender<T>) -> Command) -> Result<T, String> {
    let (reply_tx, reply_rx) = oneshot::channel();
    self
      .tx
      .send(make(reply_tx))
      .await
      .map_err(|_| "media engine stopped".to_string())?;
    reply_rx.await.map_err(|_| "media engine dropped reply".to_string())
  }

  pub async fn connect(
    &self,
    ws_url: String,
    token: String,
    channel_id: String,
    user_id: String,
  ) -> Result<(), String> {
    self
      .send(|reply| Command::Connect { ws_url, token, channel_id, user_id, reply })
      .await?
  }

  pub async fn disconnect(&self) -> Result<(), String> {
    self.send(|reply| Command::Disconnect { reply }).await
  }

  pub async fn get_state(&self) -> Result<EngineSnapshot, String> {
    self.send(|reply| Command::GetState { reply }).await
  }

  pub async fn set_muted(&self, muted: bool) -> Result<bool, String> {
    self.send(|reply| Command::SetMuted { muted, reply }).await
  }

  pub async fn set_deafened(&self, deafened: bool) -> Result<bool, String> {
    self.send(|reply| Command::SetDeafened { deafened, reply }).await
  }

  pub async fn list_devices(&self) -> Result<DeviceList, String> {
    self.send(|reply| Command::ListDevices { reply }).await?
  }

  pub async fn set_input_device(&self, device_id: String) -> Result<(), String> {
    self.send(|reply| Command::SetInputDevice { device_id, reply }).await?
  }

  pub async fn set_output_device(&self, device_id: String) -> Result<(), String> {
    self.send(|reply| Command::SetOutputDevice { device_id, reply }).await?
  }

  pub async fn set_user_volume(
    &self,
    user_id: String,
    source: VolumeSource,
    volume: u16,
  ) -> Result<(), String> {
    self
      .send(|reply| Command::SetUserVolume { user_id, source, volume, reply })
      .await?
  }

  pub async fn broadcast(&self, payload: String, topic: Option<String>) -> Result<(), String> {
    self.send(|reply| Command::Broadcast { payload, topic, reply }).await?
  }

  pub async fn enable_camera(&self, enabled: bool) -> Result<bool, String> {
    self.send(|reply| Command::EnableCamera { enabled, reply }).await?
  }

  pub async fn set_screenshare(
    &self,
    enabled: bool,
    fps: Option<u32>,
    source: Option<ScreenSource>,
  ) -> Result<bool, String> {
    self
      .send(|reply| Command::SetScreenshare { enabled, fps, source, reply })
      .await?
  }

  pub async fn set_video_device(&self, device_id: String) -> Result<(), String> {
    self.send(|reply| Command::SetVideoDevice { device_id, reply }).await?
  }

  pub async fn list_screen_sources(&self) -> Result<Vec<ScreenSource>, String> {
    self.send(|reply| Command::ListScreenSources { reply }).await
  }
}

struct CallState {
  room: Room,
  events: mpsc::UnboundedReceiver<RoomEvent>,
  channel_id: String,
  user_id: String,
  // held for its lifetime: dropping the ADM handle disables playout
  #[allow(dead_code)]
  audio: PlatformAudio,
  mic_pub: Option<LocalTrackPublication>,
  muted: bool,
  deafened: bool,
  remote_audio: HashMap<(String, VolumeSource), RemoteAudioTrack>,
  // 0..=200; 0 degrades to track disable (no per-track gain in bindings yet)
  volumes: HashMap<(String, VolumeSource), u16>,
  speaking: HashSet<String>,
  frames: FrameStore,
  camera: Option<(CameraCapture, LocalTrackPublication)>,
  screen: Option<(ScreenCapture, LocalTrackPublication)>,
  video_readers: HashMap<TileKey, tokio::task::JoinHandle<()>>,
  selected_sink: Option<String>,
  selected_source: Option<String>,
  selected_camera: Option<u32>,
}

impl Drop for CallState {
  fn drop(&mut self) {
    for (_, handle) in self.video_readers.drain() {
      handle.abort();
    }
    self.frames.clear();
  }
}

impl CallState {
  fn local_state(&self) -> UserMediaState {
    let speaking = self.speaking.contains(&self.user_id);
    UserMediaState {
      user_id: self.user_id.clone(),
      is_audio_enabled: !self.muted,
      is_video_enabled: self.camera.is_some(),
      is_screen_sharing: self.screen.is_some(),
      is_muted: self.muted,
      is_deafened: self.deafened,
      is_speaking: speaking,
      audio_level: if speaking { 50 } else { 0 },
      has_screen_share_audio: false,
    }
  }

  fn remote_state(&self, p: &RemoteParticipant) -> UserMediaState {
    let identity = remote_user_id(p);
    let speaking = self.speaking.contains(&identity);
    let mut state = UserMediaState {
      user_id: identity,
      is_audio_enabled: false,
      is_video_enabled: false,
      is_screen_sharing: false,
      is_muted: true,
      is_deafened: false,
      is_speaking: speaking,
      audio_level: if speaking { 50 } else { 0 },
      has_screen_share_audio: false,
    };
    for (_, publication) in p.track_publications() {
      match publication.source() {
        TrackSource::Microphone => {
          state.is_muted = publication.is_muted();
          state.is_audio_enabled = !publication.is_muted();
        }
        TrackSource::Camera => state.is_video_enabled = !publication.is_muted(),
        TrackSource::Screenshare => state.is_screen_sharing = !publication.is_muted(),
        TrackSource::ScreenshareAudio => state.has_screen_share_audio = !publication.is_muted(),
        TrackSource::Unknown => {}
      }
    }
    state
  }

  fn all_users(&self) -> Vec<UserMediaState> {
    self
      .room
      .remote_participants()
      .values()
      .map(|p| self.remote_state(p))
      .collect()
  }

  fn audio_track_enabled(&self, key: &(String, VolumeSource)) -> bool {
    !self.deafened && self.volumes.get(key).copied().unwrap_or(100) > 0
  }

  fn apply_audio_enabled(&self, key: &(String, VolumeSource)) {
    if let Some(track) = self.remote_audio.get(key) {
      if self.audio_track_enabled(key) {
        track.enable();
      } else {
        track.disable();
      }
    }
  }
}

async fn actor_loop(mut rx: mpsc::Receiver<Command>, sink: EventSink, frames: FrameStore) {
  let mut call: Option<CallState> = None;

  enum Step {
    Cmd(Command),
    Room(RoomEvent),
    RoomClosed,
  }

  loop {
    let step = if let Some(active) = call.as_mut() {
      tokio::select! {
        cmd = rx.recv() => match cmd {
          Some(c) => Step::Cmd(c),
          None => break,
        },
        ev = active.events.recv() => match ev {
          Some(e) => Step::Room(e),
          None => Step::RoomClosed,
        },
      }
    } else {
      match rx.recv().await {
        Some(c) => Step::Cmd(c),
        None => break,
      }
    };

    match step {
      Step::Cmd(cmd) => handle_command(cmd, &mut call, &sink, &frames).await,
      Step::Room(ev) => handle_room_event(ev, &mut call, &sink),
      Step::RoomClosed => {
        call = None;
        sink(MediaEvent::Disconnected { reason: "room closed".into() });
      }
    }
  }

  if let Some(active) = call.take() {
    let _ = active.room.close().await;
  }
}

async fn handle_command(
  cmd: Command,
  call: &mut Option<CallState>,
  sink: &EventSink,
  frames: &FrameStore,
) {
  match cmd {
    Command::Connect { ws_url, token, channel_id, user_id, reply } => {
      if let Some(old) = call.take() {
        let _ = old.room.close().await;
        sink(MediaEvent::Disconnected { reason: "rejoining".into() });
      }
      match do_connect(ws_url, token, channel_id, user_id, frames.clone(), sink).await {
        Ok(state) => {
          sink(MediaEvent::Connected { channel_id: state.channel_id.clone() });
          sink(MediaEvent::StateSynced {
            local: state.local_state(),
            users: state.all_users(),
          });
          *call = Some(state);
          let _ = reply.send(Ok(()));
        }
        Err(e) => {
          sink(MediaEvent::Error { code: "connect-failed".into(), message: e.clone() });
          let _ = reply.send(Err(e));
        }
      }
    }
    Command::Disconnect { reply } => {
      if let Some(active) = call.take() {
        let _ = active.room.close().await;
        sink(MediaEvent::Disconnected { reason: "local".into() });
      }
      let _ = reply.send(());
    }
    Command::GetState { reply } => {
      let snapshot = match call.as_ref() {
        Some(active) => EngineSnapshot {
          connected: true,
          local: Some(active.local_state()),
          users: active.all_users(),
        },
        None => EngineSnapshot { connected: false, local: None, users: vec![] },
      };
      let _ = reply.send(snapshot);
    }
    Command::SetMuted { muted, reply } => {
      let result = if let Some(active) = call.as_mut() {
        active.muted = muted;
        if let Some(publication) = &active.mic_pub {
          if muted {
            publication.mute();
          } else {
            publication.unmute();
          }
        }
        sink(MediaEvent::LocalState(active.local_state()));
        muted
      } else {
        muted
      };
      let _ = reply.send(result);
    }
    Command::SetDeafened { deafened, reply } => {
      let result = if let Some(active) = call.as_mut() {
        active.deafened = deafened;
        let keys: Vec<_> = active.remote_audio.keys().cloned().collect();
        for key in keys {
          active.apply_audio_enabled(&key);
        }
        sink(MediaEvent::LocalState(active.local_state()));
        deafened
      } else {
        deafened
      };
      let _ = reply.send(result);
    }
    Command::ListDevices { reply } => {
      let _ = reply.send(Ok(list_devices()));
    }
    Command::SetInputDevice { device_id, reply } => {
      if let Some(active) = call.as_mut() {
        active.selected_source = Some(device_id.clone());
      }
      let _ = reply.send(audio_devices::move_recording_to(&device_id));
    }
    Command::SetOutputDevice { device_id, reply } => {
      if let Some(active) = call.as_mut() {
        active.selected_sink = Some(device_id.clone());
      }
      let _ = reply.send(audio_devices::move_playback_to(&device_id));
    }
    Command::SetVideoDevice { device_id, reply } => {
      let result = match call.as_mut() {
        Some(active) => {
          active.selected_camera = device_id.parse::<u32>().ok();
          if active.camera.is_some() {
            match set_camera(active, false, sink).await {
              Ok(_) => set_camera(active, true, sink).await.map(|_| ()),
              Err(e) => Err(e),
            }
          } else {
            Ok(())
          }
        }
        None => Err("not connected".into()),
      };
      let _ = reply.send(result);
    }
    Command::ListScreenSources { reply } => {
      let _ = reply.send(list_screen_sources());
    }
    Command::SetUserVolume { user_id, source, volume, reply } => {
      let result = match call.as_mut() {
        Some(active) => {
          let key = (user_id, source);
          active.volumes.insert(key.clone(), volume.min(200));
          active.apply_audio_enabled(&key);
          Ok(())
        }
        None => Err("not connected".into()),
      };
      let _ = reply.send(result);
    }
    Command::Broadcast { payload, topic, reply } => {
      let result = match call.as_ref() {
        Some(active) => active
          .room
          .local_participant()
          .publish_data(DataPacket {
            payload: payload.into_bytes(),
            topic,
            reliable: true,
            ..Default::default()
          })
          .await
          .map_err(|e| e.to_string()),
        None => Err("not connected".into()),
      };
      let _ = reply.send(result);
    }
    Command::EnableCamera { enabled, reply } => {
      let result = match call.as_mut() {
        Some(active) => set_camera(active, enabled, sink).await,
        None => Err("not connected".into()),
      };
      let _ = reply.send(result);
    }
    Command::SetScreenshare { enabled, fps, source, reply } => {
      let result = match call.as_mut() {
        Some(active) => set_screenshare(active, enabled, fps, source, sink).await,
        None => Err("not connected".into()),
      };
      let _ = reply.send(result);
    }
  }
}

async fn set_camera(
  active: &mut CallState,
  enabled: bool,
  sink: &EventSink,
) -> Result<bool, String> {
  if enabled == active.camera.is_some() {
    return Ok(enabled);
  }

  if enabled {
    let capture = CameraCapture::start(active.selected_camera, active.frames.clone())?;
    let track = LocalVideoTrack::create_video_track(
      "camera",
      RtcVideoSource::Native(capture.source.clone()),
    );
    let mut options = TrackPublishOptions::default();
    options.source = TrackSource::Camera;
    options.simulcast = true;
    let publication = active
      .room
      .local_participant()
      .publish_track(LocalTrack::Video(track), options)
      .await
      .map_err(|e| format!("publish camera: {e}"))?;
    active.camera = Some((capture, publication));
  } else if let Some((capture, publication)) = active.camera.take() {
    capture.stop();
    let _ = active.room.local_participant().unpublish_track(&publication.sid()).await;
  }

  sink(MediaEvent::LocalState(active.local_state()));
  Ok(enabled)
}

async fn set_screenshare(
  active: &mut CallState,
  enabled: bool,
  fps: Option<u32>,
  source: Option<ScreenSource>,
  sink: &EventSink,
) -> Result<bool, String> {
  if enabled == active.screen.is_some() {
    return Ok(enabled);
  }

  if enabled {
    let capture = ScreenCapture::start(fps.unwrap_or(60), source, active.frames.clone())?;
    let track = LocalVideoTrack::create_video_track(
      "screen",
      RtcVideoSource::Native(capture.source.clone()),
    );
    let mut options = TrackPublishOptions::default();
    options.source = TrackSource::Screenshare;
    let publication = active
      .room
      .local_participant()
      .publish_track(LocalTrack::Video(track), options)
      .await
      .map_err(|e| format!("publish screenshare: {e}"))?;
    active.screen = Some((capture, publication));
  } else if let Some((capture, publication)) = active.screen.take() {
    capture.stop();
    let _ = active.room.local_participant().unpublish_track(&publication.sid()).await;
  }

  sink(MediaEvent::LocalState(active.local_state()));
  Ok(enabled)
}

async fn do_connect(
  ws_url: String,
  token: String,
  channel_id: String,
  user_id: String,
  frames: FrameStore,
  _sink: &EventSink,
) -> Result<CallState, String> {
  let audio = PlatformAudio::new().map_err(|e| format!("platform audio: {e}"))?;
  let _ = audio.set_echo_cancellation(true, true);
  let _ = audio.set_noise_suppression(true, true);
  let _ = audio.set_auto_gain_control(true, true);

  let mut options = RoomOptions::default();
  options.adaptive_stream = true;
  options.dynacast = true;
  let (room, events) = Room::connect(&ws_url, &token, options)
    .await
    .map_err(|e| format!("room connect: {e}"))?;

  let mic_track = LocalAudioTrack::create_audio_track("microphone", audio.rtc_source());
  let mut publish_options = TrackPublishOptions::default();
  publish_options.source = TrackSource::Microphone;
  publish_options.dtx = true;
  publish_options.red = true;
  let mic_pub = room
    .local_participant()
    .publish_track(LocalTrack::Audio(mic_track), publish_options)
    .await
    .map_err(|e| format!("publish mic: {e}"))?;

  Ok(CallState {
    room,
    events,
    channel_id,
    user_id,
    audio,
    mic_pub: Some(mic_pub),
    muted: false,
    deafened: false,
    remote_audio: HashMap::new(),
    volumes: HashMap::new(),
    speaking: HashSet::new(),
    frames,
    camera: None,
    screen: None,
    video_readers: HashMap::new(),
    selected_sink: None,
    selected_source: None,
    selected_camera: None,
  })
}

fn list_devices() -> DeviceList {
  DeviceList {
    inputs: audio_devices::list_inputs(),
    outputs: audio_devices::list_outputs(),
    cameras: list_cameras()
      .into_iter()
      .map(|(id, label)| DeviceInfo { id, label })
      .collect(),
  }
}

fn handle_room_event(ev: RoomEvent, call: &mut Option<CallState>, sink: &EventSink) {
  let Some(active) = call.as_mut() else { return };
  match ev {
    RoomEvent::ParticipantConnected(p) => {
      sink(MediaEvent::UserJoined(active.remote_state(&p)));
    }
    RoomEvent::ParticipantDisconnected(p) => {
      let identity = remote_user_id(&p);
      active.remote_audio.retain(|(id, _), _| *id != identity);
      active.speaking.remove(&identity);
      active.video_readers.retain(|key, handle| {
        if key.user_id == identity {
          handle.abort();
          false
        } else {
          true
        }
      });
      active.frames.remove_user(&identity);
      sink(MediaEvent::UserLeft { user_id: identity });
    }
    RoomEvent::TrackSubscribed { track, publication, participant } => {
      match track {
        RemoteTrack::Audio(audio_track) => {
          let source = match publication.source() {
            TrackSource::ScreenshareAudio => VolumeSource::Screen,
            _ => VolumeSource::Mic,
          };
          let key = (remote_user_id(&participant), source);
          active.remote_audio.insert(key.clone(), audio_track);
          active.apply_audio_enabled(&key);
        }
        RemoteTrack::Video(video_track) => {
          let key = TileKey {
            user_id: remote_user_id(&participant),
            is_screen: publication.source() == TrackSource::Screenshare,
          };
          let frames = active.frames.clone();
          let reader_key = key.clone();
          let mut stream = NativeVideoStream::new(video_track.rtc_track());
          let handle = tokio::spawn(async move {
            while let Some(frame) = stream.next().await {
              let buffer = frame.buffer.to_i420();
              let (sy, su, sv) = buffer.strides();
              let (y, u, v) = buffer.data();
              frames.put(
                reader_key.clone(),
                pack_i420(buffer.width(), buffer.height(), y, sy, u, su, v, sv),
              );
            }
          });
          if let Some(old) = active.video_readers.insert(key, handle) {
            old.abort();
          }
        }
      }
      sink(MediaEvent::UserState(active.remote_state(&participant)));
    }
    RoomEvent::TrackUnsubscribed { track, publication, participant } => {
      match track {
        RemoteTrack::Audio(_) => {
          let source = match publication.source() {
            TrackSource::ScreenshareAudio => VolumeSource::Screen,
            _ => VolumeSource::Mic,
          };
          active.remote_audio.remove(&(remote_user_id(&participant), source));
        }
        RemoteTrack::Video(_) => {
          let key = TileKey {
            user_id: remote_user_id(&participant),
            is_screen: publication.source() == TrackSource::Screenshare,
          };
          if let Some(handle) = active.video_readers.remove(&key) {
            handle.abort();
          }
          active.frames.remove(&key);
        }
      }
      sink(MediaEvent::UserState(active.remote_state(&participant)));
    }
    RoomEvent::TrackPublished { participant, .. }
    | RoomEvent::TrackUnpublished { participant, .. } => {
      sink(MediaEvent::UserState(active.remote_state(&participant)));
    }
    RoomEvent::TrackMuted { participant, .. } | RoomEvent::TrackUnmuted { participant, .. } => {
      match participant {
        Participant::Remote(p) => sink(MediaEvent::UserState(active.remote_state(&p))),
        Participant::Local(_) => sink(MediaEvent::LocalState(active.local_state())),
      }
    }
    RoomEvent::ActiveSpeakersChanged { speakers } => {
      let now: HashSet<String> = speakers.iter().map(participant_user_id).collect();
      let mut levels: Vec<AudioLevel> = Vec::new();
      for id in now.difference(&active.speaking) {
        levels.push(AudioLevel { user_id: id.clone(), level: 50 });
      }
      for id in active.speaking.difference(&now) {
        levels.push(AudioLevel { user_id: id.clone(), level: 0 });
      }
      active.speaking = now;
      if !levels.is_empty() {
        sink(MediaEvent::AudioLevels { levels });
      }
    }
    RoomEvent::ConnectionStateChanged(state) => {
      let label = match state {
        ConnectionState::Connected => "connected",
        ConnectionState::Reconnecting => "reconnecting",
        ConnectionState::Disconnected => "disconnected",
      };
      sink(MediaEvent::ConnectionState { state: label.into() });
    }
    RoomEvent::Reconnecting => {
      sink(MediaEvent::ConnectionState { state: "reconnecting".into() });
    }
    RoomEvent::Reconnected => {
      sink(MediaEvent::ConnectionState { state: "connected".into() });
    }
    RoomEvent::DataReceived { payload, topic, participant, .. } => {
      if let Ok(text) = String::from_utf8(payload.to_vec()) {
        sink(MediaEvent::Data {
          user_id: participant.map(|p| remote_user_id(&p)),
          topic,
          payload: text,
        });
      }
    }
    RoomEvent::Disconnected { reason } => {
      let reason = format!("{reason:?}");
      *call = None;
      sink(MediaEvent::Disconnected { reason });
    }
    _ => {}
  }
}
