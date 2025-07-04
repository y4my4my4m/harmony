import { supabase } from '@/supabase'
import { useNotificationStore } from '@/stores/useNotification'
import type { NotificationType, NotificationData, Message, MessagePart, MentionContent } from '@/types'

/**
 * Professional Discord-like Notification Orchestrator
 * 
 * Handles all notification logic with:
 * - Rate limiting and deduplication
 * - Smart recipient detection
 * - Discord-like notification rules
 * - Batch processing for performance
 * - Comprehensive event handling
 */
export class NotificationOrchestrator {
  private static instance: NotificationOrchestrator
  private pendingNotifications: Map<string, any> = new Map()
  private rateLimitMap: Map<string, number> = new Map()
  private readonly RATE_LIMIT_WINDOW = 60000 // 1 minute
  private readonly MAX_NOTIFICATIONS_PER_MINUTE = 10

  public static getInstance(): NotificationOrchestrator {
    if (!NotificationOrchestrator.instance) {
      NotificationOrchestrator.instance = new NotificationOrchestrator()
    }
    return NotificationOrchestrator.instance
  }

  /**
   * Handle new message notifications (mentions, DMs, replies)
   */
  async handleMessageEvent(
    message: Message,
    context: {
      serverId?: string
      channelId?: string
      conversationId?: string
      channelName?: string
      serverName?: string
      isEdit?: boolean
    }
  ) {
    try {
      console.log('🔔 Orchestrator: Processing message event', { messageId: message.id, context })

      if (context.isEdit) {
        // Don't send notifications for message edits
        return
      }

      // Get sender details
      const senderDetails = await this.getUserDetails(message.user_id)
      if (!senderDetails) return

      // Process different notification types
      await Promise.all([
        this.processMentions(message, senderDetails, context),
        this.processReplyNotification(message, senderDetails, context),
        this.processDMNotification(message, senderDetails, context)
      ])

    } catch (error) {
      console.error('❌ Orchestrator: Error handling message event:', error)
    }
  }

  /**
   * Handle reaction notifications
   */
  async handleReactionEvent(
    messageId: string,
    messageAuthorId: string,
    reactorUserId: string,
    emojiName: string,
    context: {
      serverId?: string
      channelId?: string
      conversationId?: string
      channelName?: string
      serverName?: string
      isRemoval?: boolean
    }
  ) {
    try {
      console.log('🔔 Orchestrator: Processing reaction event', { messageId, context })

      // Don't notify for reaction removals or self-reactions
      if (context.isRemoval || messageAuthorId === reactorUserId) {
        return
      }

      // Check rate limiting
      if (this.isRateLimited(`reaction-${reactorUserId}-${messageAuthorId}`)) {
        console.log('⏰ Orchestrator: Reaction notification rate limited')
        return
      }

      const reactorDetails = await this.getUserDetails(reactorUserId)
      if (!reactorDetails) return

      if (context.conversationId) {
        // DM reaction notification
        await this.createNotificationSafely(
          messageAuthorId,
          'reaction',
          `${reactorDetails.username} reacted to your message`,
          `with ${emojiName}`,
          {
            message_id: messageId,
            conversation_id: context.conversationId,
            user_id: reactorUserId,
            username: reactorDetails.username,
            avatar_url: reactorDetails.avatar_url,
            emoji_name: emojiName
          }
        )
      } else if (context.serverId && context.channelId) {
        // Server reaction notification
        await this.createNotificationSafely(
          messageAuthorId,
          'reaction',
          `${reactorDetails.username} reacted to your message`,
          `with ${emojiName} in #${context.channelName || 'unknown'}`,
          {
            message_id: messageId,
            server_id: context.serverId,
            channel_id: context.channelId,
            user_id: reactorUserId,
            username: reactorDetails.username,
            avatar_url: reactorDetails.avatar_url,
            server_name: context.serverName,
            channel_name: context.channelName,
            emoji_name: emojiName
          }
        )
      }

    } catch (error) {
      console.error('❌ Orchestrator: Error handling reaction event:', error)
    }
  }

  /**
   * Handle voice channel activity notifications
   */
  async handleVoiceEvent(
    userId: string,
    serverId: string,
    channelId: string,
    event: 'join' | 'leave',
    context: {
      channelName?: string
      serverName?: string
      notifyUserIds?: string[]
    }
  ) {
    try {
      console.log('🔔 Orchestrator: Processing voice event', { userId, event, context })

      const userDetails = await this.getUserDetails(userId)
      if (!userDetails) return

      const title = event === 'join' 
        ? `${userDetails.username} joined voice chat`
        : `${userDetails.username} left voice chat`

      const message = `in ${context.channelName || 'voice channel'}`

      // Notify relevant users (e.g., friends, channel members)
      const notifyUserIds = context.notifyUserIds || []
      
      await Promise.all(
        notifyUserIds.map(notifyUserId => 
          this.createNotificationSafely(
            notifyUserId,
            'voice_channel_activity',
            title,
            message,
            {
              server_id: serverId,
              channel_id: channelId,
              user_id: userId,
              username: userDetails.username,
              avatar_url: userDetails.avatar_url,
              server_name: context.serverName,
              channel_name: context.channelName,
              voice_event: event
            }
          )
        )
      )

    } catch (error) {
      console.error('❌ Orchestrator: Error handling voice event:', error)
    }
  }

  /**
   * Handle server invite notifications
   */
  async handleServerInviteEvent(
    invitedUserId: string,
    inviterUserId: string,
    serverId: string,
    inviteId: string,
    serverName: string
  ) {
    try {
      console.log('🔔 Orchestrator: Processing server invite event')

      const inviterDetails = await this.getUserDetails(inviterUserId)
      if (!inviterDetails) return

      await this.createNotificationSafely(
        invitedUserId,
        'server_invite',
        `Server invite from ${inviterDetails.username}`,
        `You've been invited to join ${serverName}`,
        {
          server_id: serverId,
          invite_id: inviteId,
          user_id: inviterUserId,
          username: inviterDetails.username,
          avatar_url: inviterDetails.avatar_url,
          server_name: serverName
        }
      )

    } catch (error) {
      console.error('❌ Orchestrator: Error handling server invite event:', error)
    }
  }

  /**
   * Process mentions in message content
   */
  private async processMentions(
    message: Message,
    senderDetails: any,
    context: any
  ) {
    if (!message.content || !Array.isArray(message.content)) return

    const mentions = message.content
      .filter((part: MessagePart) => part.type === 'mention' && 'mention' in part)
      .map((part: MessagePart) => (part as MentionContent).mention)

    if (mentions.length === 0) return

    console.log('🔔 Orchestrator: Processing mentions', mentions)

    for (const mentionedUsername of mentions) {
      // Get mentioned user ID
      const mentionedUserId = await this.getUserIdFromUsername(mentionedUsername)
      if (!mentionedUserId || mentionedUserId === message.user_id) continue

      // Check rate limiting
      if (this.isRateLimited(`mention-${message.user_id}-${mentionedUserId}`)) {
        console.log('⏰ Orchestrator: Mention notification rate limited')
        continue
      }

      const messageText = this.extractTextFromContent(message.content)

      if (context.conversationId) {
        // DM mention
        await this.createNotificationSafely(
          mentionedUserId,
          'mention',
          `${senderDetails.username} mentioned you`,
          this.truncateMessage(messageText),
          {
            message_id: message.id,
            conversation_id: context.conversationId,
            user_id: message.user_id,
            username: senderDetails.username,
            avatar_url: senderDetails.avatar_url
          }
        )
      } else if (context.serverId && context.channelId) {
        // Server mention
        await this.createNotificationSafely(
          mentionedUserId,
          'mention',
          `${senderDetails.username} mentioned you`,
          `in #${context.channelName || 'unknown'}: ${this.truncateMessage(messageText)}`,
          {
            message_id: message.id,
            server_id: context.serverId,
            channel_id: context.channelId,
            user_id: message.user_id,
            username: senderDetails.username,
            avatar_url: senderDetails.avatar_url,
            server_name: context.serverName,
            channel_name: context.channelName
          }
        )
      }
    }
  }

  /**
   * Process reply notifications
   */
  private async processReplyNotification(
    message: Message,
    senderDetails: any,
    context: any
  ) {
    if (!message.reply_to) return

    console.log('🔔 Orchestrator: Processing reply notification', { replyTo: message.reply_to })

    // Get original message author
    const originalMessage = await this.getMessageById(message.reply_to)
    if (!originalMessage || originalMessage.user_id === message.user_id) return

    // Check rate limiting
    if (this.isRateLimited(`reply-${message.user_id}-${originalMessage.user_id}`)) {
      console.log('⏰ Orchestrator: Reply notification rate limited')
      return
    }

    const messageText = this.extractTextFromContent(message.content)

    if (context.conversationId) {
      // DM reply
      await this.createNotificationSafely(
        originalMessage.user_id,
        'reply',
        `${senderDetails.username} replied to your message`,
        this.truncateMessage(messageText),
        {
          message_id: message.id,
          reply_to_message_id: message.reply_to,
          conversation_id: context.conversationId,
          user_id: message.user_id,
          username: senderDetails.username,
          avatar_url: senderDetails.avatar_url
        }
      )
    } else if (context.serverId && context.channelId) {
      // Server reply
      await this.createNotificationSafely(
        originalMessage.user_id,
        'reply',
        `${senderDetails.username} replied to your message`,
        `in #${context.channelName || 'unknown'}: ${this.truncateMessage(messageText)}`,
        {
          message_id: message.id,
          reply_to_message_id: message.reply_to,
          server_id: context.serverId,
          channel_id: context.channelId,
          user_id: message.user_id,
          username: senderDetails.username,
          avatar_url: senderDetails.avatar_url,
          server_name: context.serverName,
          channel_name: context.channelName
        }
      )
    }
  }

  /**
   * Process DM notifications for non-mentioned users
   */
  private async processDMNotification(
    message: Message,
    senderDetails: any,
    context: any
  ) {
    if (!context.conversationId) return

    console.log('🔔 Orchestrator: Processing DM notification')

    // Get conversation participants
    const { data: conversation, error } = await supabase
      .from('conversations')
      .select('user1, user2')
      .eq('id', context.conversationId)
      .single()

    if (error || !conversation) return

    // Determine recipient (the other user in the conversation)
    const recipientId = conversation.user1 === message.user_id 
      ? conversation.user2 
      : conversation.user1

    // Check rate limiting
    if (this.isRateLimited(`dm-${message.user_id}-${recipientId}`)) {
      console.log('⏰ Orchestrator: DM notification rate limited')
      return
    }

    const messageText = this.extractTextFromContent(message.content)

    await this.createNotificationSafely(
      recipientId,
      'dm',
      `New message from ${senderDetails.username}`,
      this.truncateMessage(messageText),
      {
        message_id: message.id,
        conversation_id: context.conversationId,
        user_id: message.user_id,
        username: senderDetails.username,
        avatar_url: senderDetails.avatar_url
      }
    )
  }

  /**
   * Safely create notification with error handling
   */
  private async createNotificationSafely(
    userId: string,
    type: NotificationType,
    title: string,
    message: string,
    data: NotificationData
  ) {
    try {
      const notificationStore = useNotificationStore()
      await notificationStore.createNotification(userId, type, title, message, data)
      
      // Update rate limiting
      const key = `${type}-${data.user_id}-${userId}`
      this.rateLimitMap.set(key, Date.now())
      
      console.log(`✅ Orchestrator: ${type} notification created for user ${userId}`)
    } catch (error) {
      console.error(`❌ Orchestrator: Failed to create ${type} notification:`, error)
    }
  }

  /**
   * Rate limiting check
   */
  private isRateLimited(key: string): boolean {
    const lastNotification = this.rateLimitMap.get(key)
    if (!lastNotification) return false
    
    const timeSinceLastNotification = Date.now() - lastNotification
    return timeSinceLastNotification < this.RATE_LIMIT_WINDOW
  }

  /**
   * Helper methods
   */
  private async getUserDetails(userId: string) {
    try {
      const { data: profile, error } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url')
        .eq('id', userId)
        .single()

      if (error) {
        console.error('Error fetching user details:', error)
        return null
      }

      return {
        id: profile.id,
        username: profile.username,
        display_name: profile.display_name,
        avatar_url: profile.avatar_url
      }
    } catch (error) {
      console.error('Error fetching user details:', error)
      return null
    }
  }

  private async getUserIdFromUsername(username: string): Promise<string | null> {
    try {
      const { data: profile, error } = await supabase
        .from('profiles')
        .select('id')
        .eq('username', username)
        .single()

      return error ? null : profile.id
    } catch (error) {
      console.error('Error getting user ID from username:', error)
      return null
    }
  }

  private async getMessageById(messageId: string) {
    try {
      const { data: message, error } = await supabase
        .from('messages')
        .select('id, user_id, content, channel_id, conversation_id')
        .eq('id', messageId)
        .single()

      return error ? null : message
    } catch (error) {
      console.error('Error fetching message:', error)
      return null
    }
  }

  private extractTextFromContent(content: MessagePart[]): string {
    return content
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join(' ')
  }

  private truncateMessage(content: string, maxLength = 100): string {
    if (typeof content === 'string' && content.length > maxLength) {
      return content.substring(0, maxLength) + '...'
    }
    return content || ''
  }

  /**
   * Cleanup method
   */
  cleanup() {
    this.pendingNotifications.clear()
    this.rateLimitMap.clear()
    console.log('🧹 NotificationOrchestrator cleaned up')
  }
}

// Export singleton instance
export const notificationOrchestrator = NotificationOrchestrator.getInstance()