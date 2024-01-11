export interface Server {
  id: string;
  name: string;
  channels: Channel[];
}

export interface Channel {
  id: number;
  name: string;
  type: 'text' | 'voice';
  messages: ChatMessage[];
}

export interface User {
  id: number;
  username: string;
  display_name: string;
  avatarUrl: string;
  status: 'online' | 'away' | 'busy' | 'offline';
  roles: Role[];
}

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

export interface ChatMessage {
  id: number;
  created_at: Date;
  channel_id: number;
  user_id: string;
  content: string;
  reactions?: JSON;
}

// should probably start to put these in their own files
export interface Profile {
  id?: string;
  username?: string;
  display_name?: string;
  avatar_url?: string;
  about?: string;
}

