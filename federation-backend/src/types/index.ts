export interface User {
  id: string;
  username: string;
  domain: string;
  display_name?: string;
  bio?: string;
  avatar?: string;
  banner?: string;
  is_local: boolean;
  federated_id?: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  content: any; // JSONB
  author_id: string;
  channel_id?: string;
  conversation_id?: string;
  parent_id?: string;
  is_edited: boolean;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
}

export interface Post {
  id: string;
  content: any; // JSONB
  author_id: string;
  visibility: 'public' | 'unlisted' | 'followers' | 'private';
  is_local: boolean;
  federated_id?: string;
  in_reply_to?: string;
  reblog_of?: string;
  created_at: string;
  updated_at: string;
}

export interface Server {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  banner?: string;
  owner_id: string;
  is_public: boolean;
  created_at: string;
  updated_at: string;
}

export interface Channel {
  id: string;
  name: string;
  server_id: string;
  category_id?: string;
  type: 'text' | 'voice';
  position: number;
  created_at: string;
  updated_at: string;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

export interface RequestContext {
  userId: string;
  user?: User;
  isLocal: boolean;
}

// =============================================================================
// VOICE/VIDEO ACTIVITY TYPES (Harmony Extensions)
// =============================================================================

/**
 * Voice call invitation activity
 * Used for federated DM voice/video calls
 */
export interface VoiceCallInvite {
  '@context': string[];
  id: string;
  type: 'harmony:VoiceCallInvite';
  actor: string;
  to: string[];
  object: {
    type: 'harmony:VoiceCall';
    id: string;
    callType: 'voice' | 'video';
    conversationId: string;
    livekitUrl: string; // The caller's LiveKit server URL
    roomName: string;
  };
  published: string;
}

/**
 * Voice call acceptance activity
 */
export interface VoiceCallAccept {
  '@context': string[];
  id: string;
  type: 'harmony:VoiceCallAccept';
  actor: string;
  to: string[];
  object: string; // Reference to the original VoiceCallInvite
  published: string;
}

/**
 * Voice call rejection activity
 */
export interface VoiceCallReject {
  '@context': string[];
  id: string;
  type: 'harmony:VoiceCallReject';
  actor: string;
  to: string[];
  object: string; // Reference to the original VoiceCallInvite
  published: string;
}

/**
 * Voice call ended activity
 */
export interface VoiceCallEnd {
  '@context': string[];
  id: string;
  type: 'harmony:VoiceCallEnd';
  actor: string;
  to: string[];
  object: string; // Reference to the original VoiceCallInvite
  published: string;
}

/**
 * Voice channel join activity (for server voice channels)
 */
export interface VoiceChannelJoin {
  '@context': string[];
  id: string;
  type: 'harmony:VoiceChannelJoin';
  actor: string;
  object: {
    type: 'harmony:VoiceChannel';
    id: string;
    name: string;
    serverId: string;
    serverName: string;
  };
  target: string; // Server ActivityPub ID
  published: string;
}

/**
 * Voice channel leave activity
 */
export interface VoiceChannelLeave {
  '@context': string[];
  id: string;
  type: 'harmony:VoiceChannelLeave';
  actor: string;
  object: {
    type: 'harmony:VoiceChannel';
    id: string;
  };
  published: string;
}

/**
 * Voice channel join accept activity (response with LiveKit token)
 * Sent by the server owner's instance back to the joining user's instance
 */
export interface VoiceChannelJoinAccept {
  '@context': string[];
  id: string;
  type: 'harmony:VoiceChannelJoinAccept';
  actor: string; // Server AP ID
  to: string[]; // The user who requested to join
  object: string; // Reference to the original VoiceChannelJoin activity
  result: {
    type: 'harmony:VoiceToken';
    livekitUrl: string;
    token: string;
    roomName: string;
    expiresAt: string;
  };
  published: string;
}

/**
 * Voice channel join reject activity
 * Sent when user doesn't have permission to join
 */
export interface VoiceChannelJoinReject {
  '@context': string[];
  id: string;
  type: 'harmony:VoiceChannelJoinReject';
  actor: string;
  to: string[];
  object: string;
  reason?: string;
  published: string;
}

/**
 * Union type for all voice activities
 */
export type VoiceActivity = 
  | VoiceCallInvite 
  | VoiceCallAccept 
  | VoiceCallReject 
  | VoiceCallEnd
  | VoiceChannelJoin 
  | VoiceChannelLeave
  | VoiceChannelJoinAccept
  | VoiceChannelJoinReject;

