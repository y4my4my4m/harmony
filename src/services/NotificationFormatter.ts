/**
 * NotificationFormatter - Client-side message formatting service
 * 
 * Generates user-facing messages from structured notification data.
 * Designed to be easily internationalized by replacing message templates.
 */

import type { Notification, NotificationType } from '@/types'

export interface NotificationMessage {
  title: string
  message: string
  shortTitle?: string // For badges/compact views
}

// Message templates - easy to replace for internationalization
const MESSAGE_TEMPLATES = {
  mention: {
    title: (data: any) => `${data.sender.username} mentioned you in #${data.location.channel_name}`,
    message: (data: any) => data.message.content_preview || 'Click to view message',
    shortTitle: (data: any) => `Mention in #${data.location.channel_name}`
  },
  
  dm: {
    title: (data: any) => `${data.sender.username} sent you a message`,
    message: (data: any) => data.message.content_preview || 'Click to view message',
    shortTitle: (data: any) => `DM from ${data.sender.username}`
  },
  
  reaction: {
    title: (data: any) => {
      if (data.location) {
        return `${data.reactor.username} reacted to your message in #${data.location.channel_name}`
      } else {
        return `${data.reactor.username} reacted to your message`
      }
    },
    message: (data: any) => `${data.reaction.emoji_name} reaction`,
    shortTitle: (data: any) => `${data.reaction.emoji_name} reaction`
  },
  
  reply: {
    title: (data: any) => `${data.sender.username} replied to your message in #${data.location.channel_name}`,
    message: (data: any) => data.message.content_preview || 'Click to view reply',
    shortTitle: (data: any) => `Reply in #${data.location.channel_name}`
  },
  
  server_invite: {
    title: (data: any) => `${data.inviter.username} invited you to join ${data.server.name}`,
    message: (data: any) => data.message || 'Click to accept or decline',
    shortTitle: (data: any) => `Server invite`
  },
  
  friend_request: {
    title: (data: any) => `${data.sender.username} sent you a friend request`,
    message: (data: any) => data.message || 'Click to accept or decline',
    shortTitle: (data: any) => `Friend request`
  },
  
  voice_channel_activity: {
    title: (data: any) => `Voice activity in ${data.location.channel_name}`,
    message: (data: any) => data.message || 'Someone joined the voice channel',
    shortTitle: (data: any) => `Voice activity`
  },
  
  server_update: {
    title: (data: any) => data.title || 'Server update',
    message: (data: any) => data.message || 'Server has been updated',
    shortTitle: (data: any) => `Server update`
  },
  
  emoji_added: {
    title: (data: any) => `New emoji added: ${data.emoji.name}`,
    message: (data: any) => `${data.emoji.name} is now available in ${data.location.server_name}`,
    shortTitle: (data: any) => `New emoji`
  }
} as const

export class NotificationFormatter {
  /**
   * Format a notification into user-facing messages
   */
  static formatNotification(notification: Notification): NotificationMessage {
    const template = MESSAGE_TEMPLATES[notification.type as keyof typeof MESSAGE_TEMPLATES]
    
    if (!template) {
      // Fallback for unknown notification types
      return {
        title: 'New notification',
        message: 'You have a new notification',
        shortTitle: 'Notification'
      }
    }
    
    try {
      return {
        title: template.title(notification.data),
        message: template.message(notification.data),
        shortTitle: template.shortTitle?.(notification.data) || template.title(notification.data)
      }
    } catch (error) {
      console.warn('Error formatting notification:', error, notification)
      
      // Fallback for malformed data
      return {
        title: `New ${notification.type} notification`,
        message: 'Click to view details',
        shortTitle: notification.type
      }
    }
  }
  
  /**
   * Get a short preview text for the notification
   */
  static getPreviewText(notification: Notification): string {
    const formatted = this.formatNotification(notification)
    return formatted.message
  }
  
  /**
   * Get username from notification data
   */
  static getUsername(notification: Notification): string {
    const data = notification.data
    return data.sender?.username || data.reactor?.username || data.inviter?.username || 'Unknown'
  }
  
  /**
   * Get avatar URL from notification data
   */
  static getAvatarUrl(notification: Notification): string {
    const data = notification.data
    return data.sender?.avatar_url || data.reactor?.avatar_url || data.inviter?.avatar_url || '/default_avatar.png'
  }
  
  /**
   * Get server name from notification data
   */
  static getServerName(notification: Notification): string | null {
    return notification.data.location?.server_name || null
  }
  
  /**
   * Get channel name from notification data
   */
  static getChannelName(notification: Notification): string | null {
    return notification.data.location?.channel_name || null
  }
  
  /**
   * Check if notification is clickable (has navigation target)
   */
  static isClickable(notification: Notification): boolean {
    const data = notification.data
    return !!(
      data.conversation?.id ||
      (data.location?.server_id && data.location?.channel_id) ||
      data.location?.server_id
    )
  }
  
  /**
   * Get navigation data for clicking notification
   */
  static getNavigationData(notification: Notification) {
    const data = notification.data
    
    if (data.conversation?.id) {
      return {
        type: 'conversation' as const,
        conversationId: data.conversation.id,
        messageId: data.message?.id
      }
    }
    
    if (data.location?.server_id && data.location?.channel_id) {
      return {
        type: 'channel' as const,
        serverId: data.location.server_id,
        channelId: data.location.channel_id,
        messageId: data.message?.id
      }
    }
    
    if (data.location?.server_id) {
      return {
        type: 'server' as const,
        serverId: data.location.server_id
      }
    }
    
    return null
  }
}

// Export for easy future internationalization
export { MESSAGE_TEMPLATES as NotificationTemplates }