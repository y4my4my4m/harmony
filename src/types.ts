export interface Server {
  id: string;
  name: string;
  description: string;
  owner: string;
  icon: string;
}

export interface Channel {
  id: string;
  name: string;
  // type: 'text' | 'voice';
  type: 0 | 1;
}

// TODO: FIXME! User is NOT profile (user is the auth user, profile is the user's profile)
export interface User {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string;
  status: UserStatus;
  roles: Role[];
  color?: string;
  about?: string;
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
export interface Message {
  id: string;
  created_at: Date;
  channel_id: number;
  user_id: string;
  content: string;
  reactions?: JSON;
  file_url?: string;
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
