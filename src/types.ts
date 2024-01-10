export interface Server {
  id: number;
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
  avatarUrl: string;
  status: 'online' | 'away' | 'busy' | 'offline';
  roles: Role[];
}

export interface Role {
  id: number;
  name: string;
  permissions: Permission[];
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
  sender: string; // Could be replaced by User type if more user info is needed
  content: string;
  timestamp: Date;
}
