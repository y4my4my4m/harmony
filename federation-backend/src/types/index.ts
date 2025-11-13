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

