export interface Server {
  id: string;
  name: string;
  description: string;
  owner: string;
  icon: string;
  allow_cross_server_emojis: boolean;
  public: boolean;
  created_at?: string;
}

export interface Channel {
  id: string;
  name: string;
  // type: 'text' | 'voice';
  type: number;
  category: string;
  order: number;
}


export interface Category {
  id: string;
  name: string;
  order: number;
  server_id: string;
  expanded: boolean;
}
// TODO: FIXME! User is NOT profile (user is the auth user, profile is the user's profile)
export interface User {
  id: string;
  username?: string;
  display_name?: string;
  avatar_url?: string;
  status: UserStatus;
  created_at?: string;
  updated_at?: string;
  last_seen?: string;
}

export interface Profile {
  id: string;
  username: string;
  display_name: string;
  avatar_url?: string;
  status?: UserStatus;
  // roles: Role[];
  color?: string;
  about?: string;
}

export enum UserStatus {
  Offline = 0,
  Online = 1,
  Away = 2,
  Busy = 3
}
export interface TextContent {
  type: 'text';
  text: string;
}

export interface UrlContent {
  type: 'url';
  url: string;
  preview: boolean;
}

export interface MentionContent {
  type: 'mention';
  mention: string;
  userId: string;
}

export interface EmojiContent {
  type: 'emoji';
  emoji: Emoji;
}

export interface FileContent {
  type: 'file';
  url: string;
  fileType: string; // e.g., 'image', 'video'
}

export type MessagePart = TextContent | UrlContent | MentionContent | EmojiContent | FileContent;

export interface Reaction {
  id: string;
  created_at: Date;
  message_id: string;
  emoji_id: string;
  user_id: string;
  count: number; // doesn't exist in the database, we're transforming it
  emoji: Emoji; // doesn't exist in the database, we're transforming it
  reactions: Reaction[]; // doesn't exist in the database, we're transforming it
}
export interface Message {
  id: string;
  created_at: Date;
  channel_id?: string;
  conversation_id?: string; // for DMs
  user_id: string;
  content: MessagePart[];
  reply_to?: string;
  reactions?: Reaction[]; // doesn't exist in the database, we're transforming it
  is_system?: boolean; // for system messages like join/leave announcements
}

// should probably start to put these in their own files
export interface Role {
  id: number;
  name: string;
  permissions: Permission[];
  color: string;
}

export enum Permission {
  VIEW_CHANNEL,
  SEND_MESSAGE,
  MANAGE_MESSAGES,
  MANAGE_CHANNEL,
  // Add more permissions as needed
}
export interface Gif {
  id: string;
  // add more formats?
  media_formats: {
      gif: {url:string},
      gifpreview: {url:string},
      mp4: {url:string},
      webm: {url:string}
  }
  title?: string;
}

export interface Emoji {
  id: string;
  created_at: Date;
  updated_at?: Date;
  name: string;
  url: string;
  uploader: string;
  server_id: string;
  usage_count?: number;
  last_used?: Date;
}
export type ResolvedEmoji = Emoji & {
  display_name: string;
};

export interface Point {
  x: number;
  y: number;
  color: string;
}

// Supabase Presence Types
export interface PresenceState {
  user_id: string;
  display_name: string;
  avatar_url?: string;
  online_at: string;
}

export interface PresenceJoinPayload {
  key: string;
  newPresences: PresenceState[];
}

export interface PresenceLeavePayload {
  key: string;
  leftPresences: PresenceState[];
}

export interface PresenceSyncPayload {
  presences: Record<string, PresenceState[]>;
}

export type PresenceSubscriptionStatus = 
  | 'SUBSCRIBED' 
  | 'TIMED_OUT' 
  | 'CLOSED' 
  | 'CHANNEL_ERROR';

export interface RealtimePresenceState {
  [key: string]: PresenceState[];
}

// Generic type to avoid exposing internal Supabase types
export interface PresenceChannel {
  presenceState(): RealtimePresenceState;
  track(presence: PresenceState): Promise<void>;
  untrack(): void;
  on(event: string, options: any, callback: (payload: any) => void): PresenceChannel;
  subscribe(callback: (status: PresenceSubscriptionStatus) => void): void;
}

// Chat store cache interfaces
export interface ChannelCache {
  messages: Message[];
  lastFetchedAt: Date;
  oldestMessageId: string | null;
  allMessagesLoaded: boolean;
  lastModified: Date | null;
}

export interface CacheMetadata {
  channelId: string;
  lastModified: Date;
  messageCount: number;
}

// Notification System Types
export interface Notification {
  id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  message?: string;
  data: NotificationData;
  is_read: boolean;
  is_clicked: boolean;
  created_at?: string;
  updated_at?: string;
  expires_at: string;
}

export type NotificationType = 
  | 'mention'
  | 'dm' 
  | 'reaction'
  | 'reply'
  | 'server_invite'
  | 'friend_request'
  | 'voice_channel_activity'
  | 'server_update'
  | 'emoji_added';

export interface NotificationData {
  message_id?: string;
  server_id?: string;
  channel_id?: string;
  conversation_id?: string;
  user_id?: string;
  emoji_id?: string;
  invite_id?: string;
  avatar_url?: string;
  server_name?: string;
  channel_name?: string;
  username?: string;
  [key: string]: any;
}

export interface NotificationPreferences {
  id: string;
  user_id: string;
  
  // Desktop notifications
  desktop_notifications: boolean;
  desktop_mentions: boolean;
  desktop_dms: boolean;
  desktop_reactions: boolean;
  desktop_replies: boolean;
  
  // Sound notifications
  sound_notifications: boolean;
  sound_mentions: boolean;
  sound_dms: boolean;
  sound_reactions: boolean;
  sound_voice_activity: boolean;
  
  // Push notifications
  push_notifications: boolean;
  push_mentions: boolean;
  push_dms: boolean;
  push_offline_only: boolean;
  
  // Email notifications
  email_notifications: boolean;
  email_digest: boolean;
  email_digest_frequency: 'daily' | 'weekly' | 'never';
  
  // Do not disturb
  dnd_enabled: boolean;
  dnd_start_time: string;
  dnd_end_time: string;
  
  created_at: string;
  updated_at: string;
}

export interface NotificationChannel {
  id: string;
  user_id: string;
  server_id?: string;
  channel_id?: string;
  conversation_id?: string;
  muted: boolean;
  muted_until?: string;
  notification_level: 'all' | 'mentions' | 'none';
  created_at: string;
  updated_at: string;
}

export interface UnreadCount {
  id: string;
  user_id: string;
  server_id?: string;
  channel_id?: string;
  conversation_id?: string;
  unread_messages: number;
  unread_mentions: number;
  last_read_message_id?: string;
  last_read_at: string;
  created_at: string;
  updated_at: string;
}

export interface NotificationSound {
  name: string;
  url: string;
  volume: number;
}

export interface NotificationToast {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  avatar?: string;
  actions?: ToastAction[];
  duration: number;
  timestamp: Date;
}

export interface ToastAction {
  label: string;
  action: () => void;
  style?: 'primary' | 'secondary' | 'danger';
}

export interface NotificationFilter {
  type?: NotificationType;
  read?: boolean;
  userId?: string;
  serverId?: string;
  conversationId?: string;
}