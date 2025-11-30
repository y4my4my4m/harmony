/**
 * MessageService - Simplified message management (TRUSTS DATABASE TRIGGERS)
 * 
 * OPTIMIZATION: Simplified to trust your excellent database federation triggers
 * - CoreMessageService: Pure local database operations
 * - Database triggers: trigger_unified_message_federation / handle_unified_content_federation()
 * - NO manual federation decisions or activity creation needed
 * 
 * PRESERVED APIs: 
 * - ✅ Same method signatures as before
 * - ✅ Same return types and error formats
 * - ✅ Same loading patterns and race condition handling
 * - ✅ Same local-first design (immediate UI updates)
 * 
 * SIMPLIFIED ARCHITECTURE:
 * - Trust database triggers for all federation (DMs only - chat stays local)
 * - Eliminate unnecessary federation service calls
 * - Reduce database round trips significantly
 */

import { supabase } from '@/supabase'
import type { Message, MessagePart } from '@/types'
import { debug } from '@/utils/debug'

// Import only core service - database handles federation
import { coreMessageService } from './core'

export interface CreateChannelMessageData {
  content: MessagePart[]
  channelId: string
  replyTo?: string
}

export interface CreateDMMessageData {
  content: MessagePart[]
  conversationId: string
  replyTo?: string
}

export class MessageService {
  private static instance: MessageService

  static getInstance(): MessageService {
    if (!MessageService.instance) {
      MessageService.instance = new MessageService()
    }
    return MessageService.instance
  }

  // =====================================================
  // CHANNEL MESSAGES (LOCAL-ONLY: NO FEDERATION)
  // =====================================================

  /**
   * Send a channel message (local-only: no federation needed)
   */
  async sendChannelMessage(
    serverId: string,
    channelId: string,
    content: MessagePart[],
    replyTo?: string
  ): Promise<Message> {
    try {
      debug.log(`🚀 Simplified: Sending channel message to: ${channelId}`)

      // Channel messages are local-only (no federation by design)
      const message = await coreMessageService.sendChannelMessage(serverId, channelId, content, replyTo)

      debug.log(`✅ Simplified: Channel message sent successfully (local-only): ${message.id}`)
      return message

    } catch (error) {
      debug.error('❌ Simplified: Failed to send channel message:', error)
      throw error
    }
  }

  // =====================================================
  // DM MESSAGES (SIMPLIFIED: TRUST DATABASE TRIGGERS)
  // =====================================================

  /**
   * Send a DM message (simplified: database triggers handle federation)
   */
  async sendDMMessage(
    conversationId: string,
    content: MessagePart[],
    replyTo?: string
  ): Promise<Message> {
    try {
      debug.log(`🚀 Simplified: Sending DM message to conversation: ${conversationId}`)

      // Just send the message - database triggers handle federation automatically
      const message = await coreMessageService.sendDMMessage(conversationId, content, replyTo)

      debug.log(`✅ Simplified: DM message sent successfully - database handling federation: ${message.id}`)
      return message

    } catch (error) {
      debug.error('❌ Simplified: Failed to send DM message:', error)
      throw error
    }
  }

  // =====================================================
  // MESSAGE EDITING (SIMPLIFIED: TRUST DATABASE TRIGGERS)
  // =====================================================

  /**
   * Edit a message (simplified: database triggers handle federation)
   */
  async editMessage(messageId: string, newContent: MessagePart[]): Promise<Message> {
    try {
      debug.log(`🚀 Simplified: Editing message: ${messageId}`)

      // Just edit the message - database triggers handle federation automatically
      const message = await coreMessageService.editMessage(messageId, newContent)

      debug.log(`✅ Simplified: Message edited successfully - database handling federation: ${messageId}`)
      return message

    } catch (error) {
      debug.error('❌ Simplified: Failed to edit message:', error)
      throw error
    }
  }

  /**
   * Delete a message (simplified: database triggers handle federation)
   */
  async deleteMessage(messageId: string): Promise<void> {
    try {
      debug.log(`🚀 Simplified: Deleting message: ${messageId}`)

      // Just delete the message - database triggers handle federation automatically
      await coreMessageService.deleteMessage(messageId)

      debug.log(`✅ Simplified: Message deleted successfully - database handling federation: ${messageId}`)

    } catch (error) {
      debug.error('❌ Simplified: Failed to delete message:', error)
      throw error
    }
  }

  // =====================================================
  // MESSAGE REACTIONS (SIMPLIFIED: TRUST DATABASE TRIGGERS)
  // =====================================================

  /**
   * Toggle reaction on a message (simplified: database triggers handle federation)
   * Local-first design: chat reactions stay local, DM reactions may federate
   * PRESERVES: Exact same API and return type
   */
  async toggleReaction(
    messageId: string,
    emojiId: string
  ): Promise<{ added: boolean; newCount: number }> {
    try {
      debug.log(`🚀 Simplified: Toggling reaction for message: ${messageId}, emoji: ${emojiId}`)

      // Just toggle the reaction - database triggers handle federation logic automatically
      // (chat reactions stay local, DM reactions may federate based on participants)
      const result = await coreMessageService.toggleReaction(messageId, emojiId)

      // Check if this is a native/mutant emoji (not a UUID)
      const isNativeEmoji = !this.isValidUUID(emojiId)

      // Get updated count for the response - query by correct field
      let countQuery = supabase
        .from('reactions')
        .select('*', { count: 'exact', head: true })
        .eq('message_id', messageId)
      
      if (isNativeEmoji) {
        countQuery = countQuery.eq('custom_emoji_content', emojiId)
      } else {
        countQuery = countQuery.eq('emoji_id', emojiId)
      }

      const { count } = await countQuery

      const response = {
        added: result.added,
        newCount: count || 0
      }

      debug.log(`✅ Simplified: Message reaction toggled - database handling federation: ${response.added ? 'added' : 'removed'}`)
      return response

    } catch (error) {
      debug.error('❌ Simplified: Failed to toggle message reaction:', error)
      throw error
    }
  }

  /**
   * Check if a string is a valid UUID
   */
  private isValidUUID(str: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    return uuidRegex.test(str)
  }

  /**
   * Get message reactions (delegated to core service)
   * PRESERVES: Exact same API and return type
   */
  async getMessageReactions(messageId: string): Promise<Array<{
    emoji_id: string;
    emoji_name: string;
    count: number;
    users: Array<{ id: string; username: string; display_name?: string }>;
  }>> {
    try {
      debug.log(`🚀 Simplified: Loading reactions for message: ${messageId}`)

      // Delegate to core service (no federation needed for reads)
      const reactions = await coreMessageService.getMessageReactions(messageId)

      debug.log(`✅ Simplified: Loaded ${reactions.length} reaction groups`)
      return reactions

    } catch (error) {
      debug.error('❌ Simplified: Failed to load message reactions:', error)
      throw error
    }
  }

  /**
   * Get batch message reactions (delegated to core service for performance)
   * PRESERVES: Exact same API and return type
   */
  async getBatchMessageReactions(messageIds: string[]): Promise<{
    [messageId: string]: Array<{
      emoji_id: string;
      emoji_name: string;
      count: number;
      users: Array<{ id: string; username: string; display_name?: string }>;
    }>;
  }> {
    try {
      debug.log(`🚀 Simplified: Loading reactions for ${messageIds.length} messages`)

      // Delegate to core service (optimized batch query)
      const reactions = await coreMessageService.getBatchMessageReactions(messageIds)

      debug.log(`✅ Simplified: Loaded batch reactions successfully`)
      return reactions

    } catch (error) {
      debug.error('❌ Simplified: Failed to load batch message reactions:', error)
      throw error
    }
  }

  // =====================================================
  // MESSAGE LOADING (DELEGATED TO CORE SERVICE)
  // =====================================================

  /**
   * Load channel messages (delegated to core service)
   * PRESERVES: Exact same API, pagination, and performance
   */
  async loadChannelMessages(
    channelId: string,
    options: {
      limit?: number;
      before?: string;
      after?: string;
      signal?: AbortSignal;
    } = {}
  ): Promise<{
    messages: Message[];
    hasMore: boolean;
    nextCursor?: string;
  }> {
    try {
      debug.log(`🚀 Simplified: Loading channel messages for: ${channelId}`)

      // Delegate to core service (no federation needed for reads)
      const messages = await coreMessageService.loadChannelMessages(channelId, options)

      // Transform core service response to match expected API
      const { limit = 50 } = options
      const hasMore = messages.length === limit
      const nextCursor = hasMore ? messages[messages.length - 1]?.created_at : undefined
      
      const result = {
        messages,
        hasMore,
        nextCursor
      }

      debug.log(`✅ Simplified: Loaded ${messages.length} channel messages`)
      return result

    } catch (error) {
      debug.error('❌ Simplified: Failed to load channel messages:', error)
      throw error
    }
  }

  /**
   * Load conversation messages (delegated to core service)
   * PRESERVES: Exact same API, pagination, and performance
   */
  async loadConversationMessages(
    conversationId: string,
    options: {
      limit?: number;
      before?: string;
      after?: string;
      signal?: AbortSignal;
    } = {}
  ): Promise<{
    messages: Message[];
    hasMore: boolean;
    nextCursor?: string;
  }> {
    try {
      debug.log(`🚀 Simplified: Loading conversation messages for: ${conversationId}`)

      // Delegate to core service (no federation needed for reads)
      const messages = await coreMessageService.loadConversationMessages(conversationId, options)

      // Transform core service response to match expected API
      const { limit = 50 } = options
      const hasMore = messages.length === limit
      const nextCursor = hasMore ? messages[messages.length - 1]?.created_at : undefined
      
      const result = {
        messages,
        hasMore,
        nextCursor
      }

      debug.log(`✅ Simplified: Loaded ${messages.length} conversation messages`)
      return result

    } catch (error) {
      debug.error('❌ Simplified: Failed to load conversation messages:', error)
      throw error
    }
  }

  /**
   * Load a single message (delegated to core service)
   * PRESERVES: Exact same API and return type
   */
  async loadMessage(messageId: string): Promise<Message | null> {
    try {
      debug.log(`🚀 Simplified: Loading message: ${messageId}`)

      // Delegate to core service (no federation needed for reads)
      const message = await coreMessageService.loadMessage(messageId)

      if (message) {
        debug.log(`✅ Simplified: Message loaded successfully: ${messageId}`)
      } else {
        debug.log(`ℹ️ Simplified: Message not found: ${messageId}`)
      }

      return message

    } catch (error) {
      debug.error('❌ Simplified: Failed to load message:', error)
      throw error
    }
  }

  // =====================================================
  // UTILITY METHODS (PRESERVED)
  // =====================================================

  private async getCurrentUserProfileId(): Promise<string> {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .single()

    if (error || !profile) {
      throw this.createError('PROFILE_NOT_FOUND', 'User profile not found')
    }

    return profile.id
  }

  private createError(code: string, message: string, details?: any): Error {
    const error = new Error(message) as any
    error.code = code
    error.details = details
    return error
  }
}

// Export singleton instance
export const messageService = MessageService.getInstance()