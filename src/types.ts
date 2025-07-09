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
  category: string | null;
  category_id: string | null; // Added for compatibility
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
  roles?: Role[]; // Added for compatibility
  created_at?: string;
  updated_at?: string;
  last_seen?: string;
}

export interface Profile {
  id: string;
  username: string;
  display_name: string;
  domain: string; // NEW: Split from username@domain format
  avatar_url?: string;
  status?: UserStatus;
  // roles: Role[];
  color?: string;
  about?: string;
  // ActivityPub fields
  federated_id?: string;
  public_key?: string;
  inbox_url?: string;
  outbox_url?: string;
  followers_url?: string;
  following_url?: string;
  featured_url?: string;
  is_local?: boolean;
  last_synced_at?: string;
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

export interface SystemContent {
  type: 'system';
  event_type: string; // 'join' | 'leave'
  user: {
    id: string;
    username: string;
    display_name: string;
    avatar_url?: string;
  };
  initiated_by?: {
    id: string;
    username: string;
    display_name: string;
    avatar_url?: string;
  } | null;
  timestamp: string;
}

export type MessagePart = TextContent | UrlContent | MentionContent | EmojiContent | FileContent | SystemContent;

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
  | 'emoji_added'
  | 'activitypub_follow'
  | 'activitypub_favorite'
  | 'activitypub_reblog'
  | 'activitypub_mention'
  | 'activitypub_reply'
  | 'activitypub_follow_request';

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
  display_name?: string;
  
  // ActivityPub specific data
  post_id?: string;
  post_content?: string;
  post_url?: string;
  follower_id?: string;
  follower_username?: string;
  follower_display_name?: string;
  follower_avatar_url?: string;
  follower_domain?: string;
  follower_handle?: string;
  follow_id?: string;
  interaction_type?: 'favorite' | 'reblog' | 'bookmark';
  interaction_id?: string;
  mention_content?: string;
  reply_content?: string;
  activity_id?: string;
  activity_type?: string;
  timestamp?: string;
  location?: {
    server_id?: string;
    channel_id?: string;
    conversation_id?: string;
    instance_domain?: string;
  };
  
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
  
  // ActivityPub notifications
  activitypub_notifications: boolean;
  activitypub_follows: boolean;
  activitypub_favorites: boolean;
  activitypub_reblogs: boolean;
  activitypub_mentions: boolean;
  activitypub_replies: boolean;
  activitypub_follow_requests: boolean;
  
  // ActivityPub desktop notifications
  activitypub_desktop_notifications: boolean;
  activitypub_desktop_follows: boolean;
  activitypub_desktop_favorites: boolean;
  activitypub_desktop_reblogs: boolean;
  activitypub_desktop_mentions: boolean;
  activitypub_desktop_replies: boolean;
  
  // ActivityPub sound notifications
  activitypub_sound_notifications: boolean;
  activitypub_sound_follows: boolean;
  activitypub_sound_favorites: boolean;
  activitypub_sound_reblogs: boolean;
  activitypub_sound_mentions: boolean;
  activitypub_sound_replies: boolean;
  
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
  | 'mic_on'
  | 'mic_off'
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

// =============================================
// ACTIVITYPUB / MONYVERSE FEDERATION TYPES
// =============================================

export interface FederatedInstance {
  id: string;
  created_at: string;
  updated_at: string;
  domain: string;
  software?: string; // 'mastodon', 'pleroma', 'harmony', etc.
  version?: string;
  description?: string;
  admin_contact?: string;
  is_blocked: boolean;
  is_trusted: boolean;
  last_seen_at: string;
  user_count: number;
  status_count: number;
  connection_count: number;
  metadata: Record<string, any>;
}

export interface ActivityPubPost {
  id: string;
  created_at: string;
  updated_at: string;
  content: MessagePart[]; // Reuse existing content format
  content_warning?: string;
  language: string;
  author_id: string;
  ap_id?: string; // ActivityPub object ID
  ap_type: string; // 'Note', 'Article', etc.
  url?: string;
  in_reply_to?: string;
  conversation_id?: string;
  visibility: 'public' | 'unlisted' | 'followers' | 'direct';
  is_local: boolean;
  is_federated: boolean;
  replies_count: number;
  reblogs_count: number;
  favorites_count: number;
  media_attachments: MediaAttachment[];
  metadata: Record<string, any>;
  is_sensitive: boolean;
  is_deleted: boolean;
  deleted_at?: string;
}

export interface MediaAttachment {
  id: string;
  type: 'image' | 'video' | 'audio' | 'unknown';
  url: string;
  preview_url?: string;
  remote_url?: string;
  meta?: {
    width?: number;
    height?: number;
    size?: string;
    aspect?: number;
    duration?: number;
  };
  description?: string;
  blurhash?: string;
  mime_type?: string; // e.g., 'image/jpeg', 'video/mp4'
  filename?: string; // Original filename if available
  size?: number; // Size in bytes
}

export interface ActivityPubFollow {
  id: string;
  created_at: string;
  updated_at: string;
  follower_id: string;
  following_id: string;
  ap_id?: string;
  accepted_at?: string;
  status: 'pending' | 'accepted' | 'rejected';
  is_local: boolean;
  metadata: Record<string, any>;
}

export interface PostInteraction {
  id: string;
  created_at: string;
  user_id: string;
  post_id: string;
  interaction_type: 'favorite' | 'reblog' | 'bookmark';
  ap_id?: string;
  is_local: boolean;
  metadata: Record<string, any>;
}

export interface TimelineEntry {
  id: string;
  created_at: string;
  user_id: string;
  post_id: string;
  timeline_type: 'home' | 'public' | 'local' | 'notifications';
  position: number;
  metadata: Record<string, any>;
}

export interface ActivityPubActivity {
  id: string;
  created_at: string;
  ap_id: string;
  ap_type: string; // 'Create', 'Update', 'Delete', 'Follow', 'Accept', 'Reject', etc.
  actor_id?: string;
  target_id?: string;
  target_type?: string;
  activity_data: Record<string, any>;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  processed_at?: string;
  error_message?: string;
  retry_count: number;
  is_local: boolean;
  origin_domain?: string;
  metadata: Record<string, any>;
}

export interface DeliveryQueueItem {
  id: string;
  created_at: string;
  activity_id: string;
  target_domain: string;
  target_inbox_url: string;
  status: 'pending' | 'processing' | 'delivered' | 'failed';
  attempt_count: number;
  next_attempt_at: string;
  last_attempt_at?: string;
  delivered_at?: string;
  error_message?: string;
  metadata: Record<string, any>;
}

// Enhanced Post type with author info for timeline display
export interface EnhancedActivityPubPost extends ActivityPubPost {
  author: {
    id: string;
    username: string;
    display_name: string;
    avatar_url?: string;
    domain: string;
  };
  is_favorited: boolean;
  is_reblogged: boolean;
}

// Federation timeline types
export type TimelineType = 'home' | 'public' | 'local' | 'notifications';

// Federation user search result
export interface FederatedUserSearchResult {
  user_id: string;
  username: string;
  display_name: string;
  domain: string;
  avatar_url?: string;
  handle: string; // @username or @username@domain
  is_local: boolean;
}

// ActivityPub Actor (for federation)
export interface ActivityPubActor {
  '@context': string | string[];
  id: string;
  type: 'Person' | 'Service' | 'Group';
  preferredUsername: string;
  name?: string;
  summary?: string;
  icon?: {
    type: 'Image';
    mediaType: string;
    url: string;
  };
  image?: {
    type: 'Image';
    mediaType: string;
    url: string;
  };
  inbox: string;
  outbox: string;
  following: string;
  followers: string;
  featured?: string;
  publicKey: {
    id: string;
    owner: string;
    publicKeyPem: string;
  };
  endpoints?: {
    sharedInbox?: string;
  };
  url?: string;
}

// ActivityPub Object
export interface ActivityPubObject {
  '@context': string | string[];
  id: string;
  type: string;
  attributedTo: string;
  content: string;
  published: string;
  to?: string[];
  cc?: string[];
  inReplyTo?: string;
  attachment?: MediaAttachment[];
  tag?: any[];
  sensitive?: boolean;
  summary?: string;
  url?: string;
}

// ActivityPub Activity
export interface ActivityPubActivityObject {
  '@context': string | string[];
  id: string;
  type: string;
  actor: string;
  object: string | ActivityPubObject;
  published: string;
  to?: string[];
  cc?: string[];
}

// Federated user type for ActivityPub/Monyverse users
export interface FederatedUser extends Profile {
  handle: string; // @username or @username@domain
  posts_count?: number;
  following_count?: number;
  followers_count?: number;
  verified?: boolean;
  bio?: string; // Alias for about
  is_following?: boolean;
  is_follower?: boolean;
  is_blocked?: boolean;
  is_muted?: boolean;
  instance_url?: string;
  last_status_at?: string;
  note?: string; // Personal note about this user
  emojis?: any[];
  fields?: Array<{
    name: string;
    value: string;
    verified_at?: string;
  }>;
}

// Additional ActivityPub types for components

// Post type alias for ActivityPub posts  
export type Post = ActivityPubPost;

// Enhanced post type for timeline display
export type TimelinePost = EnhancedActivityPubPost;

// Post composer state
export interface PostComposerState {
  content: string;
  contentWarning?: string;
  visibility: 'public' | 'unlisted' | 'followers' | 'direct';
  sensitive: boolean;
  language: string;
  replyTo?: string;
  mediaAttachments: MediaAttachment[];
  poll?: {
    options: string[];
    multiple: boolean;
    expiresIn: number; // seconds
  };
  scheduledAt?: string;
}

// Feed structure for timeline management
export interface MonyFeed {
  posts: TimelinePost[];
  has_more: boolean;
  cursor?: string;
  loading?: boolean;
  error?: string;
}

export interface TimelineOptions {
  limit?: number;
  max_id?: string;
  since_id?: string;
  min_id?: string;
}

export type Follow = ActivityPubFollow;