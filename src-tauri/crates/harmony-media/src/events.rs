use serde::Serialize;

// field names mirror src/services/livekitWebRTC.ts UserMediaState
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMediaState {
  pub user_id: String,
  pub is_audio_enabled: bool,
  pub is_video_enabled: bool,
  pub is_screen_sharing: bool,
  pub is_muted: bool,
  pub is_deafened: bool,
  pub is_speaking: bool,
  pub audio_level: u8,
  pub has_screen_share_audio: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLevel {
  pub user_id: String,
  pub level: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MediaEvent {
  #[serde(rename_all = "camelCase")]
  Connected { channel_id: String },
  #[serde(rename_all = "camelCase")]
  Disconnected { reason: String },
  UserJoined(UserMediaState),
  #[serde(rename_all = "camelCase")]
  UserLeft { user_id: String },
  UserState(UserMediaState),
  LocalState(UserMediaState),
  #[serde(rename_all = "camelCase")]
  StateSynced {
    local: UserMediaState,
    users: Vec<UserMediaState>,
  },
  // struct variant: internally-tagged serde can't wrap a bare Vec
  AudioLevels { levels: Vec<AudioLevel> },
  #[serde(rename_all = "camelCase")]
  Data {
    user_id: Option<String>,
    topic: Option<String>,
    payload: String,
  },
  #[serde(rename_all = "camelCase")]
  ConnectionState { state: String },
  #[serde(rename_all = "camelCase")]
  Error { code: String, message: String },
}
