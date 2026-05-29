/**
 * NotificationFormatter - Client-side message formatting service
 * 
 * Generates user-facing messages from structured notification data.
 * Designed to be easily internationalized by replacing message templates.
 */

import type { Notification } from '@/types'
import { getAvatarUrl as utilGetAvatarUrl } from '@/utils/avatarUtils'
import { debug } from '@/utils/debug'

export interface NotificationMessage {
  title: string
  message: string
  shortTitle?: string // For badges/compact views
  /** Action phrase shown after the actor display name in the notification list UI */
  titleAction?: string
}

function getActorFromData(data: Record<string, any>) {
  return (
    data.sender ||
    data.actor ||
    data.reactor ||
    data.author ||
    data.user ||
    data.follower ||
    data.inviter
  )
}

function getActorDisplayName(data: Record<string, any>): string {
  const actor = getActorFromData(data)
  return (
    actor?.display_name ||
    actor?.username ||
    data.sender_display_name ||
    data.sender_username ||
    'Someone'
  )
}

/**
 * Safely extract a text string from content that may be a string,
 * a MessagePart[] array, or a JSON-encoded array string.
 */
function extractContentText(content: any): string | null {
  if (!content) return null
  if (typeof content === 'string') {
    if (content.startsWith('[')) {
      try { content = JSON.parse(content) } catch { return content }
    } else {
      return content
    }
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part: any) => {
        if (part.type === 'text') return part.text
        if (part.type === 'mention') return `@${part.username || ''}`
        if (part.type === 'emoji') return `:${part.emoji?.name || part.emoji || ''}:`
        if (part.type === 'hashtag') return `#${part.name || ''}`
        if (part.type === 'url') return part.url || ''
        return ''
      })
      .join(' ')
      .trim()
    return text || null
  }
  if (typeof content === 'object') return null
  return String(content)
}

function dmTitleAction(data: Record<string, any>): string {
  if (data.is_invite) {
    return ` added you to ${data.conversation?.name || 'a conversation'}`
  }
  return ' sent you a message'
}

function mentionTitleAction(data: Record<string, any>): string {
  const channelName = data.location?.channel_name || data.channel_name || 'channel'
  return ` mentioned you in #${channelName}`
}

function replyTitleAction(data: Record<string, any>): string {
  const channelName = data.location?.channel_name || data.channel_name || 'channel'
  return ` replied to your message in #${channelName}`
}

function threadReplyTitleAction(data: Record<string, any>): string {
  const channelName = data.location?.channel_name || data.channel_name || 'a thread'
  return ` replied in a thread in #${channelName}`
}

// Message templates - easy to replace for internationalization
const MESSAGE_TEMPLATES = {
  mention: {
    titleAction: mentionTitleAction,
    title: (data: any) => getActorDisplayName(data) + mentionTitleAction(data),
    message: (data: any) => {
      const text = extractContentText(data.message?.content_preview)
        || extractContentText(data.preview || data.content_preview)
        || extractContentText(data.message?.content)
      if (text) {
        return text.length > 100 ? text.substring(0, 100) + '...' : text
      }
      return 'Click to view message'
    },
    shortTitle: (data: any) => {
      const channelName = data.location?.channel_name || data.channel_name || 'channel'
      return `Mention in #${channelName}`
    }
  },
  
  dm: {
    titleAction: dmTitleAction,
    title: (data: any) => getActorDisplayName(data) + dmTitleAction(data),
    message: (data: any) => {
      const text = extractContentText(data.message?.content_preview)
        || extractContentText(data.message?.content || data.content)
        || extractContentText(data.preview || data.content_preview)
      if (text) {
        return text.length > 100 ? text.substring(0, 100) + '...' : text
      }
      return 'Click to view message'
    },
    shortTitle: (data: any) => {
      const sender = data.sender
      const senderUsername = sender?.display_name || sender?.username || data.sender_username || data.sender_display_name || 'Someone'
      if (data.is_invite) return `Invited by ${senderUsername}`
      return `DM from ${senderUsername}`
    }
  },

  chat_message: {
    titleAction: () => ' sent a message',
    title: (data: any) => getActorDisplayName(data) + ' sent a message',
    message: (data: any) => {
      const text = extractContentText(data.message?.content_preview)
        || extractContentText(data.preview || data.content_preview)
      if (text) {
        return text.length > 100 ? text.substring(0, 100) + '...' : text
      }
      return 'Click to view message'
    },
    shortTitle: (data: any) => {
      const sender = data.sender
      const senderUsername = sender?.display_name || sender?.username || data.sender_username || data.sender_display_name || 'Someone'
      return `Message from ${senderUsername}`
    }
  },
  
  reaction: {
    titleAction: () => ' reacted to your message',
    title: (data: any) => getActorDisplayName(data) + ' reacted to your message',
    message: (data: any) => {
      const preview = extractContentText(data.message_preview)
        || extractContentText(data.message?.content_preview)
      if (preview) {
        const truncated = preview.substring(0, 100)
        return truncated + (preview.length > 100 ? '...' : '')
      }
      return 'Click to view message'
    },
    shortTitle: () => 'Reaction'
  },
  
  reply: {
    titleAction: replyTitleAction,
    title: (data: any) => getActorDisplayName(data) + replyTitleAction(data),
    message: (data: any) => {
      const preview = data.message?.content_preview || data.preview || data.content_preview
      if (preview && preview.length > 100) {
        return preview.substring(0, 100) + '...'
      }
      return preview || 'Click to view reply'
    },
    shortTitle: (data: any) => {
      const channelName = data.location?.channel_name || data.channel_name || 'channel'
      return `Reply in #${channelName}`
    }
  },
  
  server_invite: {
    title: (data: any) => `${data.inviter.username} invited you to join ${data.server.name}`,
    message: (data: any) => data.message || 'Click to accept or decline',
    shortTitle: (_data: any) => `Server invite`
  },
  
  friend_request: {
    title: (data: any) => `${data.sender.username} wants to follow you`,
    message: (data: any) => data.message || 'Click to accept or decline',
    shortTitle: (_data: any) => `Follow request`
  },
  
  voice_channel_activity: {
    title: (data: any) => `Voice activity in ${data.location.channel_name}`,
    message: (data: any) => data.message || 'Someone joined the voice channel',
    shortTitle: (_data: any) => `Voice activity`
  },
  
  server_update: {
    title: (data: any) => data.title || 'Server update',
    message: (data: any) => data.message || 'Server has been updated',
    shortTitle: (_data: any) => `Server update`
  },
  
  emoji_added: {
    title: (data: any) => `New emoji added: ${data.emoji.name}`,
    message: (data: any) => `${data.emoji.name} is now available in ${data.location.server_name}`,
    shortTitle: (_data: any) => `New emoji`
  },

  // ActivityPub notification templates
  activitypub_follow: {
    title: (data: any) => {
      const displayName = data.follower.display_name || data.follower.username
      const handle = data.follower.handle || `@${data.follower.username}${!data.follower.is_local ? '@' + data.follower.domain : ''}`
      return `${displayName} (${handle}) started following you`
    },
    message: (data: any) => {
      const handle = data.follower.handle || `@${data.follower.username}${!data.follower.is_local ? '@' + data.follower.domain : ''}`
      return `${handle} is now following you`
    },
    shortTitle: (_data: any) => `New follower`
  },

  activitypub_favorite: {
    title: (data: any) => `${data.user.display_name || data.user.username} favorited your post`,
    message: (data: any) => {
      const text = extractContentText(data.post_content) || extractContentText(data.post?.content_preview)
      if (text) {
        const truncated = text.substring(0, 120)
        return `"${truncated}${text.length > 120 ? '...' : ''}"`
      }
      return 'Click to see the post';
    },
    shortTitle: () => `Post favorited`
  },

  activitypub_reblog: {
    title: (data: any) => `${data.user.display_name || data.user.username} reblogged your post`,
    message: (data: any) => {
      const text = extractContentText(data.post_content) || extractContentText(data.post?.content_preview)
      if (text) {
        const truncated = text.substring(0, 120)
        return `"${truncated}${text.length > 120 ? '...' : ''}"`
      }
      return 'Click to see the post';
    },
    shortTitle: () => `Post reblogged`
  },

  activitypub_mention: {
    titleAction: () => ' mentioned you',
    title: (data: any) => getActorDisplayName(data) + ' mentioned you',
    message: (data: any) => {
      const text = extractContentText(data.post?.content_preview) || extractContentText(data.post_content)
      if (text) {
        const truncated = text.substring(0, 120)
        return `"${truncated}${text.length >= 120 ? '...' : ''}"`
      }
      return 'Click to see the mention'
    },
    shortTitle: () => `Federated mention`
  },

  activitypub_reply: {
    titleAction: () => ' replied to your post',
    title: (data: any) => getActorDisplayName(data) + ' replied to your post',
    message: (data: any) => {
      const text = extractContentText(data.post_content)
        || extractContentText(data.post?.content_preview)
        || extractContentText(data.post?.content)
      if (text) {
        const truncated = text.substring(0, 120)
        return `"${truncated}${text.length > 120 ? '...' : ''}"`
      }
      return 'Click to see the reply';
    },
    shortTitle: () => `New reply`
  },

  activitypub_reaction: {
    titleAction: () => ' reacted to your post',
    title: (data: any) => getActorDisplayName(data) + ' reacted to your post',
    message: (data: any) => {
      const text = extractContentText(data.post?.content_preview)
        || extractContentText(data.post_content)
      if (text) {
        const truncated = text.substring(0, 100)
        return truncated + (text.length > 100 ? '...' : '')
      }
      return 'Click to view post'
    },
    shortTitle: () => 'Reaction'
  },

  activitypub_follow_request: {
    title: (data: any) => `${data.follower.display_name || data.follower.username} wants to follow you`,
    message: (data: any) => `${data.follower.handle || '@' + data.follower.username} sent you a follow request`,
    shortTitle: (_data: any) => `Follow request`
  },

  thread_reply: {
    titleAction: threadReplyTitleAction,
    title: (data: any) => getActorDisplayName(data) + threadReplyTitleAction(data),
    message: (data: any) => {
      const text = extractContentText(data.message?.content_preview)
        || extractContentText(data.preview)
      if (text) {
        return text.length > 100 ? text.substring(0, 100) + '...' : text
      }
      return 'Click to view thread'
    },
    shortTitle: (data: any) => {
      const channelName = data.location?.channel_name || data.channel_name || 'thread'
      return `Thread reply in #${channelName}`
    }
  },

  report_update: {
    title: (data: any) => {
      const status = data.status || 'updated'
      switch (status) {
        case 'investigating': return 'Your report is being reviewed'
        case 'resolved': return 'Your report has been resolved'
        case 'dismissed': return 'Your report has been reviewed'
        default: return 'Report status updated'
      }
    },
    message: (data: any) => {
      const type = data.report_type || 'content'
      const status = data.status || 'updated'
      const note = data.resolution_note
      let msg = `Your ${type} report has been ${status}.`
      if (note && note.trim()) msg += ` Note: ${note.trim()}`
      return msg
    },
    shortTitle: () => 'Report update'
  },

  /**
   * Sent to all admins + moderators when a webhook donation arrives that
   * couldn't be auto-matched to a user (no handle in message, or no profile
   * matched). Mirrors the reports notification pattern: action is admin-only.
   */
  admin_pending_donation: {
    title: (data: any) => {
      const platform = (data.platform || 'unknown').toString()
      const platformLabel = platform.charAt(0).toUpperCase() + platform.slice(1)
      return `New ${platformLabel} donation needs review`
    },
    message: (data: any) => {
      const amount = data.amount != null ? Number(data.amount).toFixed(2) : '?'
      const currency = data.currency || 'USD'
      const donor = data.donor_name?.trim()
      const donorPart = donor ? ` from ${donor}` : ''
      return `${currency} ${amount}${donorPart} couldn't be matched to a user - open the admin panel to attribute it.`
    },
    shortTitle: () => 'Donation needs review',
  },
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
    
    const data = notification.data || {}

    let title: string
    try {
      title = template.title(data)
    } catch (e) {
      debug.warn('Error formatting notification title:', e, notification)
      title = `New ${notification.type} notification`
    }

    let message: string
    try {
      message = template.message(data)
    } catch (e) {
      debug.warn('Error formatting notification message:', e, notification)
      message = 'Click to view details'
    }

    let shortTitle: string
    try {
      shortTitle = template.shortTitle?.(data) || title
    } catch (e) {
      shortTitle = title
    }

    let titleAction: string | undefined
    try {
      if ('titleAction' in template && typeof template.titleAction === 'function') {
        titleAction = template.titleAction(data)
      }
    } catch (e) {
      debug.warn('Error formatting notification titleAction:', e, notification)
    }

    return { title, message, shortTitle, titleAction }
  }

  /**
   * Action phrase after the actor name (e.g. " sent you a message").
   */
  static getTitleAction(notification: Notification): string {
    const formatted = this.formatNotification(notification)
    if (formatted.titleAction) return formatted.titleAction
    return ''
  }

  /**
   * Web handle from notification payload (set by DB via notification_actor_json).
   */
  static getActorHandle(notification: Notification): string | null {
    const actor = getActorFromData(notification.data || {})
    if (!actor?.handle) return null
    const h = String(actor.handle)
    return h.startsWith('@') ? h : `@${h}`
  }

  static getActorDisplayNameFallback(notification: Notification): string {
    return getActorDisplayName(notification.data || {})
  }
  
  /**
   * Get the actor's profile user ID and the title suffix (part after the actor name).
   * Used by toast notifications to render DisplayName with custom emojis.
   */
  static getActorInfo(notification: Notification): { actorUserId: string; titleSuffix: string } | null {
    const data = notification.data || {}

    let actorUserId: string | null = null
    let actorDisplayName: string | null = null

    // Extract actor from structured notification data
    const actor = data.sender || data.reactor || data.actor || data.inviter || data.follower || data.user || data.author
    if (actor) {
      actorUserId = actor.user_id || actor.id || null
      actorDisplayName = actor.display_name || actor.username || null
    }

    // Legacy fallbacks
    if (!actorUserId && data.from_user_id) {
      actorUserId = data.from_user_id
    }

    if (!actorUserId || !actorDisplayName) return null

    // Extract the suffix by finding the actor name in the formatted title
    const formatted = this.formatNotification(notification)
    const title = formatted.title
    const nameIndex = title.indexOf(actorDisplayName)
    if (nameIndex === -1) return null

    const suffix = title.substring(nameIndex + actorDisplayName.length)
    return { actorUserId, titleSuffix: suffix }
  }

  /**
   * Get a short preview text for the notification
   */
  static getPreviewText(notification: Notification): string {
    const formatted = this.formatNotification(notification)
    return formatted.message
  }
  
  /**
   * Get username from notification data (includes domain for remote users)
   * Handles both structured format (sender object) and legacy format
   */
  static getUsername(notification: Notification): string {
    const data = notification.data
    
    // For ActivityPub notifications, prioritize the handle (includes domain)
    if (notification.type.startsWith('activitypub_')) {
      // Check sender first (for reactions)
      if (data.sender?.handle) return data.sender.handle
      if (data.follower?.handle) return data.follower.handle
      if (data.actor?.handle) return data.actor.handle
      if (data.user?.handle) return data.user.handle
      if (data.author?.handle) return data.author.handle
      
      // Fallback to constructing handle for ActivityPub users
      const user = data.sender || data.follower || data.actor || data.user || data.author
      if (user) {
        const username = user.display_name || user.username
        if (!user.is_local && user.domain) {
          return `@${user.username}@${user.domain}`
        }
        return username || 'Unknown'
      }
    }
    
    // For non-ActivityPub notifications, prioritize structured sender object
    if (data.sender) {
      // Structured format: sender object with display_name, username, domain
      const displayName = data.sender.display_name || data.sender.username
      if (data.sender.domain && !data.sender.is_local) {
        return `${displayName}@${data.sender.domain}`
      }
      return displayName || 'Unknown'
    }
    
    // Legacy format fallbacks
    if (data.sender_username || data.sender_display_name) {
      return data.sender_display_name || data.sender_username || 'Unknown'
    }
    
    // Other notification types
    if (data.reactor) {
      return data.reactor.display_name || data.reactor.username || 'Unknown'
    }
    
    if (data.inviter) {
      return data.inviter.display_name || data.inviter.username || 'Unknown'
    }

    // Report updates: default to generic label (harassment/backlash prevention); show resolver only if moderator opted in
    if (notification.type === 'report_update') {
      if (data.show_resolver && (data.resolver_display_name || data.resolver_username)) {
        return data.resolver_display_name || data.resolver_username || 'Admin/Moderator'
      }
      return 'Admin/Moderator'
    }
    
    return 'Unknown'
  }
  
  /**
   * Get avatar URL from notification data
   * Handles both structured format (sender object) and legacy format
   */
  static getAvatarUrl(notification: Notification): string {
    const data = notification.data
    
    // Prioritize structured sender object
    let avatar = data.sender?.avatar_url
    
    // ActivityPub notifications (sender is already checked above, but check others too)
    if (!avatar && notification.type.startsWith('activitypub_')) {
      avatar = data.sender?.avatar_url ||
               data.actor?.avatar_url ||
               data.follower?.avatar_url ||
               data.user?.avatar_url ||
               data.author?.avatar_url
    }
    
    // Other notification types
    if (!avatar) {
      avatar = data.reactor?.avatar_url ||
               data.inviter?.avatar_url
    }
    
    // Legacy format fallback
    if (!avatar && data.sender_avatar_url) {
      avatar = data.sender_avatar_url
    }

    // Report updates: use resolver avatar only if show_resolver; otherwise generic default
    if (notification.type === 'report_update' && !data.show_resolver) {
      return utilGetAvatarUrl(null) || '/default_avatar.webp'
    }
    if (notification.type === 'report_update' && data.resolver_avatar_url) {
      avatar = data.resolver_avatar_url
    }

    return utilGetAvatarUrl(avatar) || '/default_avatar.webp'
  }
  
  /**
   * Get server name from notification data
   * Handles both structured format and legacy format
   */
  static getServerName(notification: Notification): string | null {
    const data = notification.data
    return (data.location as any)?.server_name || data.server_name || null
  }
  
  /**
   * Get channel name from notification data
   * Handles both structured format and legacy format
   */
  static getChannelName(notification: Notification): string | null {
    const data = notification.data
    return (data.location as any)?.channel_name || data.channel_name || null
  }
  
  /**
   * Check if notification is clickable (has navigation target)
   * Handles both structured format and legacy format
   */
  static isClickable(notification: Notification): boolean {
    const data = notification.data
    return !!(
      data.conversation?.id ||
      data.conversation_id ||
      (data.location?.server_id && data.location?.channel_id) ||
      (data.server_id && data.channel_id) ||
      data.location?.server_id ||
      data.server_id ||
      // ActivityPub notifications with post IDs
      (notification.type.startsWith('activitypub_') && data.post_id) ||
      // Follow notifications navigate to the follower's profile
      (notification.type === 'activitypub_follow' && data.follower) ||
      (notification.type === 'activitypub_follow_request' && data.follower)
    )
  }
  
  /**
   * Get navigation data for clicking notification
   * Handles both structured format and legacy format
   */
  static getNavigationData(notification: Notification) {
    const data = notification.data
    
    // ActivityPub follow → navigate to follower's profile
    if (notification.type === 'activitypub_follow' || notification.type === 'activitypub_follow_request') {
      const follower = data.follower
      if (follower) {
        const handle = follower.is_local
          ? follower.username
          : `${follower.username}@${follower.domain}`
        return {
          type: 'profile' as const,
          handle,
          userId: follower.id || follower.user_id
        }
      }
    }

    // ActivityPub post navigation
    if (notification.type.startsWith('activitypub_') && data.post_id) {
      return {
        type: 'activitypub_post' as const,
        postId: data.post_id,
        postUrl: data.post_url,
        highlightUser: data.author?.id || data.user?.id
      }
    }
    
    // DM/Conversation navigation - check both structured and legacy formats
    const conversationId = data.conversation?.id || data.conversation_id
    if (conversationId) {
      return {
        type: 'conversation' as const,
        conversationId: conversationId,
        messageId: data.message?.id || data.message_id
      }
    }
    
    // Channel navigation - check both structured and legacy formats
    const serverId = data.location?.server_id || data.server_id
    const channelId = data.location?.channel_id || data.channel_id
    if (serverId && channelId) {
      return {
        type: 'channel' as const,
        serverId: serverId,
        channelId: channelId,
        messageId: data.message?.id || data.message_id
      }
    }
    
    // Server-only navigation
    if (serverId) {
      return {
        type: 'server' as const,
        serverId: serverId
      }
    }
    
    return null
  }
}

// Export for easy future internationalization
export { MESSAGE_TEMPLATES as NotificationTemplates }