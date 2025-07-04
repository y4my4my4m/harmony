/**
 * NotificationOrchestrator - Coordinates notification creation across different contexts
 * This service handles the business logic for when and how to create notifications
 */

import { useNotificationStore } from '@/stores/useNotification'
import type { NotificationType, NotificationData } from '@/types'

export class NotificationOrchestrator {
  /**
   * Create a mention notification
   */
  static async createMentionNotification(
    userId: string,
    mentionedBy: string,
    message: string,
    context: {
      server_id?: string
      channel_id?: string
      conversation_id?: string
      server_name?: string
      channel_name?: string
      avatar_url?: string
      message_id?: string
    }
  ) {
    const notificationStore = useNotificationStore()
    
    const title = context.conversation_id 
      ? `${mentionedBy} mentioned you`
      : `${mentionedBy} mentioned you in #${context.channel_name}`
    
    const notificationData: NotificationData = {
      username: mentionedBy,
      avatar_url: context.avatar_url,
      server_id: context.server_id,
      channel_id: context.channel_id,
      conversation_id: context.conversation_id,
      server_name: context.server_name,
      channel_name: context.channel_name,
      message_id: context.message_id
    }

    return await notificationStore.createNotification(
      userId,
      'mention',
      title,
      message,
      notificationData
    )
  }

  /**
   * Create a DM notification
   */
  static async createDMNotification(
    userId: string,
    senderName: string,
    message: string,
    context: {
      conversation_id: string
      avatar_url?: string
      message_id?: string
    }
  ) {
    const notificationStore = useNotificationStore()
    
    const notificationData: NotificationData = {
      username: senderName,
      avatar_url: context.avatar_url,
      conversation_id: context.conversation_id,
      message_id: context.message_id
    }

    return await notificationStore.createNotification(
      userId,
      'dm',
      `${senderName} sent you a message`,
      message,
      notificationData
    )
  }

  /**
   * Create a reaction notification
   */
  static async createReactionNotification(
    userId: string,
    reactedBy: string,
    emoji: string,
    context: {
      server_id?: string
      channel_id?: string
      conversation_id?: string
      server_name?: string
      channel_name?: string
      avatar_url?: string
      message_id?: string
    }
  ) {
    const notificationStore = useNotificationStore()
    
    const location = context.conversation_id 
      ? 'your message'
      : `your message in #${context.channel_name}`
    
    const notificationData: NotificationData = {
      username: reactedBy,
      avatar_url: context.avatar_url,
      server_id: context.server_id,
      channel_id: context.channel_id,
      conversation_id: context.conversation_id,
      server_name: context.server_name,
      channel_name: context.channel_name,
      message_id: context.message_id,
      emoji
    }

    return await notificationStore.createNotification(
      userId,
      'reaction',
      `${reactedBy} reacted to ${location}`,
      `${emoji}`,
      notificationData
    )
  }

  /**
   * Create a reply notification
   */
  static async createReplyNotification(
    userId: string,
    repliedBy: string,
    message: string,
    context: {
      server_id?: string
      channel_id?: string
      conversation_id?: string
      server_name?: string
      channel_name?: string
      avatar_url?: string
      message_id?: string
      original_message_id?: string
    }
  ) {
    const notificationStore = useNotificationStore()
    
    const location = context.conversation_id 
      ? 'your message'
      : `your message in #${context.channel_name}`
    
    const notificationData: NotificationData = {
      username: repliedBy,
      avatar_url: context.avatar_url,
      server_id: context.server_id,
      channel_id: context.channel_id,
      conversation_id: context.conversation_id,
      server_name: context.server_name,
      channel_name: context.channel_name,
      message_id: context.message_id,
      original_message_id: context.original_message_id
    }

    return await notificationStore.createNotification(
      userId,
      'reply',
      `${repliedBy} replied to ${location}`,
      message,
      notificationData
    )
  }

  /**
   * Create a server invite notification
   */
  static async createServerInviteNotification(
    userId: string,
    invitedBy: string,
    serverName: string,
    context: {
      server_id: string
      avatar_url?: string
      invite_code?: string
    }
  ) {
    const notificationStore = useNotificationStore()
    
    const notificationData: NotificationData = {
      username: invitedBy,
      avatar_url: context.avatar_url,
      server_id: context.server_id,
      server_name: serverName,
      invite_code: context.invite_code
    }

    return await notificationStore.createNotification(
      userId,
      'server_invite',
      `${invitedBy} invited you to ${serverName}`,
      `You've been invited to join ${serverName}`,
      notificationData
    )
  }

  /**
   * Create a friend request notification
   */
  static async createFriendRequestNotification(
    userId: string,
    requesterName: string,
    context: {
      requester_id: string
      avatar_url?: string
    }
  ) {
    const notificationStore = useNotificationStore()
    
    const notificationData: NotificationData = {
      username: requesterName,
      avatar_url: context.avatar_url,
      requester_id: context.requester_id
    }

    return await notificationStore.createNotification(
      userId,
      'friend_request',
      `${requesterName} sent you a friend request`,
      `${requesterName} wants to be your friend`,
      notificationData
    )
  }

  /**
   * Create a voice channel activity notification
   */
  static async createVoiceActivityNotification(
    userId: string,
    userName: string,
    activity: 'joined' | 'left' | 'speaking',
    context: {
      server_id: string
      channel_id: string
      server_name: string
      channel_name: string
      avatar_url?: string
    }
  ) {
    const notificationStore = useNotificationStore()
    
    const activityText = {
      joined: 'joined',
      left: 'left',
      speaking: 'started speaking in'
    }[activity]
    
    const notificationData: NotificationData = {
      username: userName,
      avatar_url: context.avatar_url,
      server_id: context.server_id,
      channel_id: context.channel_id,
      server_name: context.server_name,
      channel_name: context.channel_name,
      activity
    }

    return await notificationStore.createNotification(
      userId,
      'voice_channel_activity',
      `${userName} ${activityText} ${context.channel_name}`,
      `Voice activity in ${context.server_name}`,
      notificationData
    )
  }
}