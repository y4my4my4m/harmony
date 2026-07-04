// Split out of the former monolithic src/types.ts. Import via '@/types'.
import type { MessagePart, Profile, DisplayNamePart } from './chat'

// ACTIVITYPUB / MONYVERSE FEDERATION TYPES

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
  content_warning?: string | null;
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
// Author shape attached to timeline posts by enhanced-fetch paths (timeline
// RPCs select the author profile alongside the post).
export interface PostAuthor {
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
  displayNameParts?: DisplayNamePart[];
  // PostgREST embed `supporter_membership:instance_supporters(...)`; shape is
  // normalized by FundingService.badgeFromMembership.
  supporter_membership?: any;
}

export interface EnhancedActivityPubPost extends Omit<ActivityPubPost, 'author'> {
  author: PostAuthor;
  is_favorited: boolean;
  is_reblogged: boolean;
  is_bookmarked?: boolean;
  // Reblog properties for quote posts and pure reblogs
  reblog?: ActivityPubPost;
  reblog_author?: PostAuthor;
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

// Federated user type for ActivityPub/Fediverse users
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

// POST CONTEXT TYPES (NEW ARCHITECTURE)

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

// END POST CONTEXT TYPES

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
  // Quote post support. A quote of a reblog targets the inner post, which is
  // a bare ActivityPubPost without the enhanced interaction fields.
  quotePost?: TimelinePost | ActivityPubPost;
  quoteAuthor?: FederatedUser | PostAuthor;
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

// ACTIVITYPUB FEDERATION TYPES

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
