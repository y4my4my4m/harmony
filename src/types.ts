export interface Server {
  id: string;
  name: string;
  description: string;
  owner: string;
  icon: string;
  allow_cross_server_emojis: boolean;
  public: boolean;
}

export interface Channel {
  id: string;
  name: string;
  // type: 'text' | 'voice';
  type: number;
  category: string;
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
  channel_id: number;
  user_id: string;
  content: MessagePart[];
  reply_to?: string;
  reactions?: Reaction[]; // doesn't exist in the database, we're transforming it
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