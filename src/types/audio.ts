// Split out of the former monolithic src/types.ts. Import via '@/types'.

// Audio Theme System Types
export type AudioAction = 
  // Notification sounds
  | 'mention'
  | 'dm'
  | 'reaction'
  | 'reply'
  | 'server_invite'
  | 'friend_request'
  | 'server_update'
  | 'emoji_added'
  | 'voice_channel_activity'
  
  // Voice/Video actions
  | 'voice_connect'
  | 'voice_disconnect'
  | 'call_incoming'
  | 'call_outgoing'
  | 'call_ended'
  | 'mic_on'
  | 'mic_off'
  | 'deafen_on'
  | 'deafen_off'
  | 'camera_on'
  | 'camera_off'
  | 'screenshare_on'
  | 'screenshare_off'
  
  // UI sounds
  | 'ui_click'
  | 'ui_hover'
  | 'ui_success'
  | 'ui_error'
  | 'ui_notification';

export interface AudioTheme {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  isBuiltIn: boolean;
  preview?: string; // Preview image URL
  sounds: Partial<Record<AudioAction, string>>;
}

export interface AudioThemeSettings {
  selectedTheme: string;
  volume: number;
  lastUpdated: string;
}

export interface ThemePreferences {
  audio: AudioThemeSettings;
  // visual?: VisualThemeSettings; // Future expansion
}

