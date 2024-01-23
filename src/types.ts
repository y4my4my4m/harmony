export interface Server {
  id: string;
  name: string;
  description: string;
  owner: string;
  icon: string;
  allow_cross_server_emojis: boolean;
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

export interface ParsedMessage {
  id: string;
  created_at: Date;  // or the correct type for your date/time
  channel_id: number;
  user_id: string;
  reactions?: JSON;  // Adjust as per the actual type
  file_url?: string;
  content: (string | { url: string; userId: string; mention: string; emoji: Emoji; })[];
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
  name: string;
  url: string;
  uploader: string;
}
export type ResolvedEmoji = Emoji & {
  display_name: string;
};
