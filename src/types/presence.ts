// Split out of the former monolithic src/types.ts. Import via '@/types'.
import type { Message } from './chat'

// CUSTOM STATUS / RICH PRESENCE TYPES

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

