// Split out of the former monolithic src/types.ts. Import via '@/types'.
import type { RealtimeChannel } from '@supabase/supabase-js'
import type { Emoji } from './media'

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
  slowmode_seconds?: number;
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
  /** Ephemeral Discord bridge profile (not a Harmony profile row). */
  bridge_source?: 'discord';
  discord_id?: string;
  discord_joined_at?: string | null;
  discord_custom_status?: { text: string; emoji: string | null } | null;
  accent_color?: string | null;
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
  /** The preview is essentially just media (GIF page etc.) - render the
      image itself, not a link card. */
  mediaOnly?: boolean;
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

/** Discord-style #channel reference inside a server chat message. */
export interface ChannelMentionContent {
  type: 'channel_mention';
  channelId: string;
  serverId: string;
  name: string; // channel name without #
  /** Set when the reference came from a message share link - clicking jumps to the message. */
  messageId?: string;
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

export type MessagePart = TextContent | UrlContent | EmbedContent | MentionContent | RoleMentionContent | EmojiContent | HashtagContent | ChannelMentionContent | FileContent | SystemContent;

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
  reactions: ReactionActor[];
}

/** One participant in a reaction group (a user or a bot), with tooltip fields. */
export interface ReactionActor {
  reaction_id: string;
  user_id?: string;
  bot_id?: string;
  username?: string;
  display_name?: string;
  avatar_url?: string;
  metadata?: Reaction['metadata'];
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

// ROLE AND PERMISSION TYPES
// Full implementation in src/services/RoleService.ts

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

// THREAD TYPES
// Discord-style threaded conversations

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

// PINNED MESSAGE TYPES

export interface PinnedMessage {
  id: string;
  message_id: string;
  channel_id?: string;
  conversation_id?: string;
  pinned_by: string;
  pinned_at: string;
  message?: Message;
}

