import type { RealtimeChannel } from '@supabase/supabase-js'

export interface Server {
  id: string;
  name: string;
  description: string;
  owner: string;
  icon: string;
  banner?: string;
  allow_cross_server_emojis: boolean;
  public: boolean;
  federation_enabled?: boolean;
  is_local_server?: boolean;
  /**
   * Domain part of a remote server's ActivityPub identity, e.g. `mony.dev`.
   * Selected by `useServerChannel.fetchServersForUser` and surfaced in the
   * server-tooltip on the main nav. Optional because local servers don't
   * carry this column.
   */
  federation_domain?: string;
  /**
   * ActivityPub `inbox` URL for the (remote) server actor. Same provenance
   * as `federation_domain`.
   */
  federation_inbox_url?: string;
  created_at?: string;
  folder_id?: string | null;
  position?: number;
}

export interface ServerFolder {
  id: string;
  user_id: string;
  name: string;
  color: string;
  position: number;
  is_expanded: boolean;
  created_at?: string;
  updated_at?: string;
  // Computed/joined data
  servers?: Server[];
}

export interface Channel {
  id: string;
  name: string;
  // type: 0=text, 1=voice, 2=category
  type: number;
  // The category this channel belongs to (references channel_categories.id)
  // NOTE: Database column is 'category', NOT 'category_id'
  category: string | null;
  order: number;
  // Optional fields from database
  server_id?: string;
  description?: string;
  is_private?: boolean;
  ap_id?: string;
  is_remote?: boolean;
  federation_status?: string;
}


export interface Category {
  id: string;
  name: string;
  order: number;
  server_id: string;
  expanded: boolean;
}
/**
 * User - Represents a user in the SERVER/CHAT context (Discord-like)
 * 
 * Used for:
 * - Server member lists
 * - Voice channel participants
 * - Chat message authors
 * - Real-time presence tracking
 * 
 * Note: This is the user's representation within the chat/server system.
 * For ActivityPub/federation contexts, use Profile instead.
 * For auth context, use Supabase User from auth.getUser().
 */
/**
 * Profile field (ActivityPub PropertyValue attachment).
 *
 * Backed by the `profiles.profile_fields` jsonb column. Federated out via
 * `toActivityPub.ts` as PropertyValue attachments on the actor; federated in
 * via `fromActivityPub.ts` from the same. `value` is HTML (typically a
 * sanitized `<a>` wrapper for URL-shaped values, plain text otherwise) - the
 * display side runs it through DOMPurify before injecting via v-html.
 */
export interface ProfileField {
  name: string;
  value: string;
  /** Mastodon-style link verification timestamp; we don't currently set this. */
  verified_at?: string | null;
}

export interface User {
  id: string;
  username?: string;
  display_name?: string;
  avatar_url?: string;
  banner_url?: string;
  bio?: string;
  color?: string;
  is_admin?: boolean;
  is_moderator?: boolean;
  status: UserStatus;
  roles?: Role[]; // Server-specific roles
  created_at?: string;
  updated_at?: string;
  last_seen?: string;
  // Federation / profile fields surfaced by profile cards. Optional because
  // the chat-side `User` is built from a thinner slice of the profiles row.
  is_local?: boolean;
  domain?: string;
  followers_count?: number;
  following_count?: number;
  posts_count?: number;
  /** Custom name/value link rows shown in the profile view. */
  profile_fields?: ProfileField[];
  // Server activity fields shown in profile cards.
  message_count?: number;
  voice_time?: number;
}

/**
 * Profile - Represents a user profile in the DATABASE/FEDERATION context
 * 
 * Used for:
 * - ActivityPub federation (actors)
 * - Database profiles table
 * - User profile pages
 * - Follow/follower relationships
 * 
 * Note: This is the canonical user representation stored in the database.
 * Maps 1:1 with the profiles table and ActivityPub actors.
 */
export interface Profile {
  id: string;
  username: string;
  display_name?: string;
  bio?: string; // Include bio field
  avatar_url?: string;
  banner_url?: string; // Banner/header image
  domain?: string;
  status?: UserStatus;
  color?: string;
  is_admin?: boolean;
  is_moderator?: boolean;
  // ActivityPub fields
  federated_id?: string;
  ap_id?: string;
  followers_count?: number;
  following_count?: number;
  posts_count?: number;
  /** Custom name/value link rows. See ProfileField. */
  profile_fields?: ProfileField[];
  is_local?: boolean;
  created_at?: string;
  updated_at?: string;
  handle?: string;
  // User preferences stored on the profile row (loaded by AppInitService /
  // useVisualTheme). Both fields are JSON blobs in Postgres.
  locale?: string;
  appearance_settings?: Record<string, unknown>;
}

export interface UserData {
  // Core identity
  id: string
  username: string
  /** @user or @user@domain - from profiles.web_handle */
  handle?: string
  displayName: string
  displayNameParts?: DisplayNamePart[] // Pre-resolved display name with inline emojis
  displayNameEmojis?: Array<{ id: string; name: string; url: string }> // Pinned emojis from federation_metadata

  // Profile data
  avatarUrl?: string
  bannerUrl?: string
  bio?: string
  color?: string
  domain?: string
  createdAt: string // When the user account was created
  updatedAt?: string // When the profile was last updated in database
  roles?: any[]
  isAdmin?: boolean
  isModerator?: boolean
  messageCount?: number
  voiceTime?: number

  // Presence data (real-time)
  status: UserStatus
  customStatus?: CustomUserStatus  // Custom status text (Discord-style)
  isOnline: boolean
  isMobile: boolean  // Whether user is on mobile device
  lastSeen: string
  lastHeartbeat: string

  // Cache metadata
  isLocal: boolean // true if loaded from local cache, false if fetched from server
  lastCacheUpdate: string // When we last fetched/updated this data in our local cache
  source: 'database' | 'presence' | 'cache'
}

export type DisplayNamePart =
  | { type: 'text'; text: string }
  | { type: 'emoji'; emoji: { id: string; name: string; url: string } }

/**
 * Custom user status (Discord-style "Playing X", "Listening to Y", etc.)
 */
export interface CustomUserStatus {
  text: string           // The status text
  emoji?: string         // Optional emoji (can be custom emoji ID or unicode)
  emoji_url?: string     // URL for custom emoji image
  expiresAt?: string     // When the status expires (ISO date string)
  // Rich presence fields
  type?: 'custom' | 'playing' | 'listening' | 'watching' | 'competing' | 'streaming'
  details?: string       // Additional details (e.g., game name, song name)
  state?: string         // Current state (e.g., "In Queue", "Playing Solo")
  setAt?: string         // When the status was set
}

export interface UserContext {
  id: string
  type: 'server' | 'dm' | 'global' | 'profile' | 'friends'
  userIds: Set<string>
  channel?: RealtimeChannel
  lastSync: Date
}

/**
 * User presence status (Discord-style)
 */
export enum UserStatus {
  Offline = 0,        // Not connected
  Online = 1,         // Active and available
  Away = 2,           // Idle or manually set away (yellow moon)
  Busy = 3,           // Do Not Disturb - suppresses notifications (red)
  Invisible = 4       // Appears offline to others but still connected
}
export interface TextContent {
  type: 'text';
  text: string;
}

export interface UrlContent {
  type: 'url';
  url: string;
  preview: boolean;
  embedId?: string;
}

export type EmbedProvider = 'harmony-post' | 'harmony-invite' | 'fediverse-post' | 'youtube' | 'spotify' | 'generic';

export interface FediverseEmbedSummary {
  authorName: string;
  authorHandle: string;
  authorAvatar?: string;
  authorUrl: string;
  content: string;
  published: string;
  attachments?: Array<{
    url: string;
    mediaType?: string;
    alt?: string;
  }>;
  sensitive?: boolean;
  contentWarning?: string;
  platform?: string;
  postUrl: string;
  stats?: {
    replies?: number;
    reblogs?: number;
    favourites?: number;
  };
}

export interface HarmonyEmbedSummary {
  postId: string;
  instanceDomain: string;
  visibility: 'public' | 'unlisted' | 'followers' | 'direct';
  isLocal: boolean;
  author?: {
    id?: string;
    username?: string;
    display_name?: string;
    domain?: string;
    avatar_url?: string | null;
    color?: string | null;
  };
}

export interface EmbedPayload {
  cacheKey: string;
  url: string;
  normalizedUrl: string;
  provider: EmbedProvider;
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
  icon?: string;
  color?: string;
  html?: string;
  width?: number;
  height?: number;
  harmony?: HarmonyEmbedSummary;
  fediverse?: FediverseEmbedSummary;
  oEmbed?: Record<string, any>;
  localPostId?: string;
  fetchedAt: string;
  expiresAt: string;
}

export interface EmbedContent {
  type: 'embed';
  url: string;
  provider: EmbedProvider;
  previewId: string;
  collapsed?: boolean;
}

export interface MentionContent {
  type: 'mention';
  userId: string;
  username: string;
  domain: string;
  isLocal: boolean;
  /**
   * Optional display name carried alongside the mention for rendering,
   * populated when the mention is resolved against the profile cache.
   */
  displayName?: string;
}

export interface RoleMentionContent {
  type: 'role_mention';
  roleId: string;
  roleName: string;
  roleColor: string | null;
}

export interface EmojiContent {
  type: 'emoji';
  emoji: Emoji;
}

export interface HashtagContent {
  type: 'hashtag';
  name: string;        // hashtag name without #
  id: string;          // database UUID
  count?: number;      // usage count (optional for display)
  last_updated?: string; // last usage timestamp (optional)
  normalized?: string; // normalized name for searching (optional)
}

export interface FileContent {
  type: 'file';
  url: string;
  fileType: string; // e.g., 'image', 'video'
  fileName?: string; // Optional file name
  fileSize?: number; // Optional file size in bytes
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

export type EncryptedPayloadMap = Record<string, string>

export type MessagePart = TextContent | UrlContent | EmbedContent | MentionContent | RoleMentionContent | EmojiContent | HashtagContent | FileContent | SystemContent;

export interface Reaction {
  id: string;
  created_at: Date;
  message_id: string;
  emoji_id: string;
  user_id: string;
  count: number; // doesn't exist in the database, we're transforming it
  emoji: Emoji; // doesn't exist in the database, we're transforming it
  reactions: Reaction[]; // doesn't exist in the database, we're transforming it
  /**
   * Optional per-reaction metadata. Used by bridged Discord reactions to
   * carry the originating Discord user info so the UI can render the bridge
   * source instead of a Harmony profile lookup.
   */
  metadata?: {
    discord_user?: {
      id: string;
      username?: string;
      display_name?: string;
      avatar_url?: string;
    };
    [key: string]: unknown;
  };
}

// ReactionGroup represents an aggregated group of reactions for a specific emoji
export interface ReactionGroup {
  emoji_id: string | null;
  emoji: Emoji;
  count: number;
  /**
   * Server-computed: whether the current user is in this reaction group.
   * This (not a client-side user_id compare) is the source of truth for the
   * "reacted" highlight - it's immune to auth-id vs profile-id confusion.
   */
  current_user_reacted?: boolean;
  reactions: Array<{
    reaction_id: string;
    user_id: string;
  }>;
}
export interface Message {
  id: string;
  created_at: Date;
  updated_at?: Date; // Timestamp when message was last edited
  channel_id?: string;
  conversation_id?: string; // for DMs
  thread_id?: string; // for thread messages
  user_id?: string; // Optional - for user messages
  bot_id?: string; // Optional - for bot messages
  content: MessagePart[];
  reply_to?: string;
  reactions?: Reaction[]; // doesn't exist in the database, we're transforming it
  is_system?: boolean; // for system messages like join/leave announcements
  encrypted?: boolean; // true if this message is encrypted
  decrypted?: boolean; // true if this message was encrypted and successfully decrypted (client-side flag)
  /**
   * Client-side flag: the message is encrypted, decryption failed for lack of a
   * session key, AND it predates the current encryption identity - so the key is
   * gone for good and retrying/requesting will never succeed. UI shows a
   * distinct "permanently unavailable" state instead of a retryable glyph.
   */
  decryption_unrecoverable?: boolean;
  /**
   * Client-side verification flag for cryptographic sender binding (Megolm v2).
   *  - `true`  → signature verified against sender's published signing key.
   *  - `false` → signature missing (legacy v1) OR sender has no signing key on record.
   *              UI should show an "unverified author" indicator.
   *  - absent  → message has not been processed through decryption (e.g., plaintext message).
   */
  sender_verified?: boolean;
  encryption_metadata?: {
    algorithm: string;
    encrypted_for: string[];
    sender_key_id: string;
    timestamp: number;
    encrypted_keys?: Record<string, string>; // Map of user_id -> encrypted symmetric key (hybrid encryption)
    iv?: string; // Initialization vector for AES-GCM
    // Megolm v2 sender-binding fields
    signature?: string;
    signing_key_fingerprint?: string;
    session_id?: string;
    message_index?: number;
    sender_user_id?: string;
  };
  metadata?: Record<string, any> & {
    embeds?: Record<string, EmbedPayload>;
  }; // for federated messages and other metadata
  sending?: boolean; // local state: true while message is being sent to server
  failed?: boolean; // local state: true when message failed to send after retries
  // Pinning
  is_pinned?: boolean;
  pinned_at?: string;
  pinned_by?: string;
}

// =============================================
// ROLE AND PERMISSION TYPES
// Full implementation in src/services/RoleService.ts
// =============================================

// Legacy Role interface for backwards compatibility
export interface Role {
  id: string;
  name: string;
  permissions: string[];
  color: string;
  position?: number;
  hoist?: boolean;
  mentionable?: boolean;
}

// Legacy Permission enum - use Permission from RoleService for new code
export enum Permission {
  VIEW_CHANNEL = 'VIEW_CHANNEL',
  SEND_MESSAGE = 'SEND_MESSAGES',
  MANAGE_MESSAGES = 'MANAGE_MESSAGES',
  MANAGE_CHANNEL = 'MANAGE_CHANNELS',
}

// =============================================
// THREAD TYPES
// Discord-style threaded conversations
// =============================================

export interface Thread {
  id: string;
  channel_id: string;
  parent_message_id: string;
  name: string;
  created_by: string;
  created_at: string;
  archived: boolean;
  archived_at?: string;
  auto_archive_duration: number; // minutes: 60, 1440, 4320, 10080
  locked: boolean;
  message_count: number;
  member_count: number;
  last_message_id?: string;
  last_message_at?: string;
  ap_id?: string;
  federation_status?: 'pending' | 'synced' | 'failed';
  federation_metadata?: Record<string, any>;
}

export interface ThreadMember {
  id: string;
  thread_id: string;
  user_id: string;
  joined_at: string;
  last_read_message_id?: string;
  flags?: number;
}

export interface ThreadMessage extends Message {
  thread_id: string;
}

// =============================================
// PINNED MESSAGE TYPES
// =============================================

export interface PinnedMessage {
  id: string;
  message_id: string;
  channel_id?: string;
  conversation_id?: string;
  pinned_by: string;
  pinned_at: string;
  message?: Message;
}

// =============================================
// CUSTOM STATUS / RICH PRESENCE TYPES
// =============================================

export type ActivityType = 'custom' | 'playing' | 'listening' | 'watching' | 'competing' | 'streaming';

export interface RichPresenceStatus {
  type: ActivityType;
  text: string;
  emoji?: string;
  emoji_url?: string;
  details?: string; // e.g., game name, song name
  state?: string; // e.g., "In Queue", "Playing Solo"
  timestamps?: {
    start?: string;
    end?: string;
  };
  assets?: {
    large_image?: string;
    large_text?: string;
    small_image?: string;
    small_text?: string;
  };
  party?: {
    id?: string;
    size?: [number, number]; // [current, max]
  };
  expires_at?: string;
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
  /** Klipy item page URL (for attribution link on shared GIFs). */
  itemUrl?: string;
  /** True for clip media (video) — sent/rendered as a video, not an image. */
  isVideo?: boolean;
}

/**
 * A GIF feed item from the backend Klipy proxy. Either a GIF (same shape as
 * `Gif`) or a Klipy ad (HTML rendered in a sandboxed iframe). Ad items are only
 * present for viewers the backend decided should see ads.
 */
export interface GifAdItem {
  kind: 'ad';
  id: string;
  content: string;
  width: number;
  height: number;
}
export type GifResultItem = (Gif & { kind: 'gif' }) | GifAdItem;

export interface Emoji {
  id: string;
  created_at?: Date;
  updated_at?: Date;
  name: string;
  url: string;
  /** Byte size of the uploaded image file */
  file_size?: number;
  uploader?: string;
  server_id?: string;
  usage_count?: number;
  last_used?: Date;
  /** Ownership scope: 'server' | 'instance' | 'user'. Absent = legacy server emoji. */
  scope?: 'server' | 'instance' | 'user';
  /** True for emoji created via the Klipy AI generation API. */
  is_ai_generated?: boolean;
  /**
   * Native unicode emoji codepoint(s) when this `Emoji` is a wrapper around
   * a system emoji rather than a custom server emoji. Set by reaction code
   * paths that need to round-trip a native emoji through the `Emoji` type.
   */
  content?: string;
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
  data: NotificationData;
  is_read: boolean;
  is_clicked: boolean;
  created_at: string;
  updated_at: string;
  expires_at: string;
  read_at?: string;
}

export type NotificationType = 
  | 'mention'
  | 'dm' 
  | 'chat_message'
  | 'reaction'
  | 'reply'
  | 'thread_reply'
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
  | 'activitypub_reaction'
  | 'activitypub_follow_request'
  | 'report_update'
  | 'error';

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
  desktop_chat_messages: boolean;
  
  // Sound notifications
  sound_notifications: boolean;
  sound_mentions: boolean;
  sound_dms: boolean;
  sound_reactions: boolean;
  sound_replies: boolean;
  sound_chat_messages: boolean;
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
  emojiUrl?: string; // For reaction notifications - emoji image URL
  emojiName?: string; // For reaction notifications - emoji name fallback
  actorUserId?: string; // Profile ID of the actor for DisplayName rendering with custom emojis
  titleSuffix?: string; // Part of the title after the actor name (used with actorUserId)
  actions?: ToastAction[];
  duration: number;
  timestamp: Date;
  notificationId?: string; // Source notification id, enables click-to-navigate
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
  in_reply_to?: string; // UUID of parent post if this is a reply
  reply_context?: ReplyContext; // Rich reply context instead of simple UUID
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
  // Pin state
  is_pinned?: boolean;
  // Interaction state properties (for enhanced posts)
  is_favorited?: boolean;
  is_reblogged?: boolean;
  is_bookmarked?: boolean;
  // Reply context - populated by code paths that hydrate the local reply tree
  // (ThreadedPost, MonyPost). Optional because not all posts are fetched with
  // their reply subtree.
  replies?: ActivityPubPost[];
  // Author profile attached by enhanced-fetch paths (timeline RPCs and feed
  // queries select the author alongside the post). Kept optional because
  // bare ActivityPubPost rows from raw `.from('posts').select('*')` won't
  // have it. EnhancedActivityPubPost narrows this to required.
  author?: FederatedUser;
}

export interface MediaAttachment {
  id: string;
  type: 'image' | 'video' | 'gifv' | 'audio' | 'unknown';
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
  file?: File; // Original File reference for reliable uploads
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
  ap_type: ActivityPubActivityType;
  actor_id?: string;
  actor_ap_id?: string;     // ActivityPub actor ID
  target_id?: string;
  target_ap_id?: string;    // ActivityPub target ID  
  target_type?: ActivityPubObjectType;
  activity_data: any;       // Full ActivityPub JSON
  status: 'pending' | 'processing' | 'completed' | 'failed';
  processed_at?: string;
  error_message?: string;
  retry_count: number;
  is_local: boolean;
  origin_domain?: string;
  // Delivery tracking (for outgoing activities)
  delivered_to?: string[];     // Domains delivered to
  failed_deliveries?: string[]; // Failed delivery domains
  metadata: Record<string, any>;
}

export interface DeliveryQueueItem {
  id: string;
  created_at: string;
  updated_at: string;
  activity_id?: string;
  activity_data: any;
  target_domain: string;
  target_inbox_url: string;  // Actual column name (not target_inbox)
  status: 'pending' | 'processing' | 'delivered' | 'failed' | 'cancelled';
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;  // Actual column name (not next_retry_at)
  last_attempt_at?: string;
  delivered_at?: string;
  error_message?: string;
  http_status_code?: number;
  response_body?: string;
  delivery_duration_ms?: number;
  priority: number;
  actor_username?: string;
  actor_domain?: string;
  sender_id?: string;  // Required for signing outgoing requests
}

// Reply context for conversation threading
export interface ReplyContext {
  id: string;
  content_preview: string; // Legacy field - for backward compatibility
  content: any; // Full JSONB content for proper parsing
  author: {
    id: string;
    username: string;
    display_name: string;
    avatar_url?: string;
    domain: string;
  };
  created_at: string;
  visibility: 'public' | 'unlisted' | 'followers' | 'direct';
}

// Enhanced Post type with author info for timeline display
export interface EnhancedActivityPubPost extends Omit<ActivityPubPost, 'author'> {
  author: {
    id: string;
    username: string;
    display_name: string;
    avatar_url?: string;
    domain: string;
    bio?: string;
    is_local?: boolean;
    followers_count?: number;
    following_count?: number;
    posts_count?: number;
    created_at?: string;
    updated_at?: string;
    handle?: string;
  };
  is_favorited: boolean;
  is_reblogged: boolean;
  is_bookmarked?: boolean;
  // Reblog properties for quote posts and pure reblogs
  reblog?: ActivityPubPost;
  reblog_author?: {
    id: string;
    username: string;
    display_name: string;
    avatar_url?: string;
    domain: string;
    bio?: string;
    is_local?: boolean;
    followers_count?: number;
    following_count?: number;
    posts_count?: number;
    created_at?: string;
    updated_at?: string;
    handle?: string;
  };
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
  // Trending / verification metadata (returned by TrendingService).
  verified?: boolean;
  // ActivityPub signing public key (PEM) - used by federation config readers.
  public_key?: string;
  // ActivityPub endpoint URLs - populated when the profile row carries the
  // federation actor metadata. Optional because chat-side `User` lookups
  // don't surface these.
  inbox_url?: string;
  outbox_url?: string;
  followers_url?: string;
  following_url?: string;
  featured_url?: string;
  last_synced_at?: string;
}

// Additional ActivityPub types for components

// Post type alias for ActivityPub posts  
export type Post = ActivityPubPost;

// Enhanced post type for timeline display
export type TimelinePost = EnhancedActivityPubPost;

// Conversation thread types
export interface ConversationThread {
  id: string;
  posts: TimelinePost[];
  root_post: TimelinePost;
  reply_count: number;
  participant_count: number;
  last_updated: string;
}

export interface ConversationContext {
  ancestors: TimelinePost[]; // Posts this is replying to (going up the chain)
  descendants: TimelinePost[]; // Replies to this post (going down the chain)
}

// =============================================
// POST CONTEXT TYPES (NEW ARCHITECTURE)
// =============================================

export type PostContextType = 'minimal' | 'thread' | 'ancestors' | 'descendants';

export interface PostContextOptions {
  context?: PostContextType;
  highlightReply?: string;
  maxDepth?: number;
  includeInteractions?: boolean;
}

export interface ThreadInfo {
  totalPosts: number;
  participantCount: number;
  depth: number;
  rootPostId: string;
  lastActivity: string;
}

export interface PostWithContext {
  mainPost: TimelinePost;
  ancestors: TimelinePost[];
  descendants: TimelinePost[];
  threadInfo: ThreadInfo;
  highlightedPost?: string;
  contextType: PostContextType;
}

// =============================================
// END POST CONTEXT TYPES
// =============================================

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
  // Quote post support
  quotePost?: TimelinePost;
  quoteAuthor?: FederatedUser;
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
  /** Row offset for offset-based pagination (e.g. follower/following lists) */
  offset?: number;
  /** @deprecated Use `before` for reliable time-based pagination */
  max_id?: string;
  since_id?: string;
  min_id?: string;
  /** ISO timestamp cursor - fetch posts created before this time */
  before?: string;
}

/** Result from timeline fetches - used to set has_more from raw DB count before client-side filtering */
export interface TimelineResult {
  posts: TimelinePost[];
  /** True if the DB returned a full page (raw count >= limit) - use for pagination, not filtered posts.length */
  fullPage: boolean;
}

export type Follow = ActivityPubFollow;

// =============================================
// ACTIVITYPUB FEDERATION TYPES
// =============================================

/**
 * Complete ActivityPub Activity Types
 */
export type ActivityPubActivityType = 
  // Core object activities
  | 'Create'      // Creating posts, messages
  | 'Update'      // Editing posts, profiles
  | 'Delete'      // Deleting posts, accounts
  
  // Social activities  
  | 'Follow'      // Following users
  | 'Accept'      // Accepting follows, join requests
  | 'Reject'      // Rejecting follows, join requests
  | 'Undo'        // Undoing previous activities (unfollow, unfavorite)
  
  // Interaction activities
  | 'Like'        // Favoriting posts (maps to 'favorite')
  | 'Announce'    // Reblogging/sharing posts (maps to 'reblog')
  | 'Add'         // Adding to collections (bookmarks, lists)
  | 'Remove'      // Removing from collections
  
  // Communication activities
  | 'Invite'      // Server invitations
  | 'Join'        // Joining servers/channels
  | 'Leave'       // Leaving servers/channels
  
  // Voice/Real-time activities (Harmony extensions)
  | 'VoiceJoin'   // Joining voice channels
  | 'VoiceLeave'  // Leaving voice channels
  | 'VoiceUpdate' // Voice state updates (mute, deafen)
  
  // Moderation activities
  | 'Block'       // Blocking users/instances
  | 'Flag'        // Reporting content
  | 'Move'        // Account migration
  
  // System activities
  | 'Tombstone'; // Deleted object placeholder

/**
 * ActivityPub Object Types
 */
export type ActivityPubObjectType =
  | 'Note'         // Standard posts/messages
  | 'Article'      // Long-form content
  | 'Person'       // User profiles
  | 'Group'        // Servers/communities
  | 'Service'      // Bot accounts
  | 'Application'  // App-to-app communication
  | 'ChatServer'   // Harmony extension: Chat servers
  | 'ChatChannel'  // Harmony extension: Chat channels
  | 'ChatMessage'  // Harmony extension: Chat messages
  | 'VoiceChannel' // Harmony extension: Voice channels
  | 'VoiceSession' // Harmony extension: Voice sessions
  | 'Collection'   // Lists, bookmarks
  | 'OrderedCollection' // Ordered lists
  | 'Tombstone';   // Deleted objects

/**
 * Voice Channel Federation (Harmony Extension)
 */
export interface VoiceChannelActivity {
  id: string;
  ap_id: string;
  type: 'VoiceJoin' | 'VoiceLeave' | 'VoiceUpdate';
  actor: FederatedUser;
  object: {
    type: 'VoiceChannel';
    id: string;
    name: string;
    server_id: string;
    server_name: string;
    server_domain: string;
  };
  // Voice state data
  voice_state?: {
    muted?: boolean;
    deafened?: boolean;
    video_enabled?: boolean;
    screen_sharing?: boolean;
    speaking?: boolean;
  };
  timestamp: string;
}

/**
 * Server Federation Activity (Harmony Extension)
 */
export interface ServerFederationActivity {
  id: string;
  ap_id: string;
  type: 'Join' | 'Leave' | 'Invite' | 'Accept' | 'Reject';
  actor: FederatedUser;
  object: {
    type: 'ChatServer';
    id: string;
    name: string;
    domain: string;
    description?: string;
    icon_url?: string;
    member_count?: number;
    channel_count?: number;
  };
  // Additional context
  invite_code?: string;
  permissions?: string[];
  timestamp: string;
}

/**
 * Enhanced Post with federation metadata
 */
export interface FederatedPost extends TimelinePost {
  // Federation tracking
  federated_to?: string[];     // Domains this was federated to
  federation_status?: 'pending' | 'completed' | 'failed';
  last_federated_at?: string;
  
  // Update tracking
  edit_history?: {
    content: any;
    edited_at: string;
    reason?: string;
  }[];
  
  // Voice attachments (for voice messages)
  voice_attachments?: {
    duration: number;
    waveform?: number[];
    transcript?: string;
  }[];
}

/**
 * Instance Federation Status
 */
export interface FederatedInstanceStatus {
  domain: string;
  software: string;
  version: string;
  
  // Connection status
  is_reachable: boolean;
  last_successful_delivery?: string;
  last_failed_delivery?: string;
  consecutive_failures: number;
  
  // Capabilities
  supports_voice_federation?: boolean;
  supports_chat_federation?: boolean;
  supported_activities: ActivityPubActivityType[];
  
  // Statistics
  delivery_success_rate: number;
  average_response_time: number;
  
  // Rate limiting
  rate_limit_remaining?: number;
  rate_limit_reset?: string;
}