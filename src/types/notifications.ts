// Split out of the former monolithic src/types.ts. Import via '@/types'.

// Notification System Types
export interface Notification {
  id: string;
  user_id: string;
  type: NotificationType;
  data: NotificationData;
  is_read: boolean;
  is_clicked: boolean;
  created_at: string;
  updated_at: string;
  expires_at: string;
  read_at?: string;
}

export type NotificationType = 
  | 'mention'
  | 'dm' 
  | 'chat_message'
  | 'reaction'
  | 'reply'
  | 'thread_reply'
  | 'server_invite'
  | 'friend_request'
  | 'voice_channel_activity'
  | 'server_update'
  | 'emoji_added'
  | 'activitypub_follow'
  | 'activitypub_favorite'
  | 'activitypub_reblog'
  | 'activitypub_mention'
  | 'activitypub_reply'
  | 'activitypub_reaction'
  | 'activitypub_follow_request'
  | 'activitypub_follow_accepted'
  | 'report_update'
  | 'error'
  // Generic UI feedback toasts (also valid AudioActions for themed sounds)
  | 'ui_success'
  | 'ui_error';

export interface NotificationData {
  message_id?: string;
  server_id?: string;
  channel_id?: string;
  conversation_id?: string;
  user_id?: string;
  emoji_id?: string;
  invite_id?: string;
  avatar_url?: string;
  server_name?: string;
  channel_name?: string;
  username?: string;
  display_name?: string;
  
  // ActivityPub specific data
  post_id?: string;
  post_content?: string;
  post_url?: string;
  follower_id?: string;
  follower_username?: string;
  follower_display_name?: string;
  follower_avatar_url?: string;
  follower_domain?: string;
  follower_handle?: string;
  follow_id?: string;
  interaction_type?: 'favorite' | 'reblog' | 'bookmark';
  interaction_id?: string;
  mention_content?: string;
  reply_content?: string;
  activity_id?: string;
  activity_type?: string;
  timestamp?: string;
  location?: {
    server_id?: string;
    channel_id?: string;
    conversation_id?: string;
    instance_domain?: string;
  };
  
  [key: string]: any;
}

export interface NotificationPreferences {
  id: string;
  user_id: string;
  
  // Desktop notifications
  desktop_notifications: boolean;
  desktop_mentions: boolean;
  desktop_dms: boolean;
  desktop_reactions: boolean;
  desktop_replies: boolean;
  desktop_chat_messages: boolean;
  
  // Sound notifications
  sound_notifications: boolean;
  sound_mentions: boolean;
  sound_dms: boolean;
  sound_reactions: boolean;
  sound_replies: boolean;
  sound_chat_messages: boolean;
  sound_voice_activity: boolean;
  
  // Push notifications
  push_notifications: boolean;
  push_mentions: boolean;
  push_dms: boolean;
  push_offline_only: boolean;
  
  // Email notifications
  email_notifications: boolean;
  email_digest: boolean;
  email_digest_frequency: 'daily' | 'weekly' | 'never';
  
  // Do not disturb
  dnd_enabled: boolean;
  dnd_start_time: string;
  dnd_end_time: string;
  
  // ActivityPub notifications
  activitypub_notifications: boolean;
  activitypub_follows: boolean;
  activitypub_favorites: boolean;
  activitypub_reblogs: boolean;
  activitypub_mentions: boolean;
  activitypub_replies: boolean;
  activitypub_follow_requests: boolean;
  
  // ActivityPub desktop notifications
  activitypub_desktop_notifications: boolean;
  activitypub_desktop_follows: boolean;
  activitypub_desktop_favorites: boolean;
  activitypub_desktop_reblogs: boolean;
  activitypub_desktop_mentions: boolean;
  activitypub_desktop_replies: boolean;
  
  // ActivityPub sound notifications
  activitypub_sound_notifications: boolean;
  activitypub_sound_follows: boolean;
  activitypub_sound_favorites: boolean;
  activitypub_sound_reblogs: boolean;
  activitypub_sound_mentions: boolean;
  activitypub_sound_replies: boolean;
  
  created_at: string;
  updated_at: string;
}

export interface NotificationChannel {
  id: string;
  user_id: string;
  server_id?: string;
  channel_id?: string;
  conversation_id?: string;
  muted: boolean;
  muted_until?: string;
  notification_level: 'all' | 'mentions' | 'none';
  created_at: string;
  updated_at: string;
}

export interface UnreadCount {
  id: string;
  user_id: string;
  server_id?: string;
  channel_id?: string;
  conversation_id?: string;
  unread_messages: number;
  unread_mentions: number;
  last_read_message_id?: string;
  last_read_at: string;
  created_at: string;
  updated_at: string;
}

export interface NotificationSound {
  name: string;
  url: string;
  volume: number;
}

export interface NotificationToast {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  avatar?: string;
  emojiUrl?: string; // For reaction notifications - emoji image URL
  emojiName?: string; // For reaction notifications - emoji name fallback
  actorUserId?: string; // Profile ID of the actor for DisplayName rendering with custom emojis
  titleSuffix?: string; // Part of the title after the actor name (used with actorUserId)
  actions?: ToastAction[];
  duration: number;
  timestamp: Date;
  notificationId?: string; // Source notification id, enables click-to-navigate
}

export interface ToastAction {
  label: string;
  action: () => void;
  style?: 'primary' | 'secondary' | 'danger';
}

export interface NotificationFilter {
  type?: NotificationType;
  read?: boolean;
  userId?: string;
  serverId?: string;
  conversationId?: string;
}

