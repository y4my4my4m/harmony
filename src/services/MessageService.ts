/**
 * MessageService - Message operations (local DB + notification/reaction triggers)
 * 
 * Delegates to CoreMessageService; federation is handled by database triggers where applicable.
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
import { coreMessageService, type SendOptions } from './core'

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

// Re-export for callers (chat stores, components) so they don't have to
// reach into the core layer to use the fail-closed override flag.
export type { SendOptions }

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
   *
   * `options.allowPlaintextFallback` opts into plaintext sending when the
   * channel is encryption-eligible but encryption fails / is unavailable.
   * Default is fail-closed - callers must catch ENCRYPTION_* errors and
   * confirm with the user before retrying with the override.
   */
  async sendChannelMessage(
    serverId: string,
    channelId: string,
    content: MessagePart[],
    replyTo?: string,
    extraMetadata?: Record<string, any>,
    options?: SendOptions
  ): Promise<Message> {
    try {
      debug.log(`🚀 MessageService: Sending channel message to: ${channelId}`)

      // Channel messages are local-only (no federation by design)
      const message = await coreMessageService.sendChannelMessage(serverId, channelId, content, replyTo, extraMetadata, options)

      debug.log(`✅ MessageService: Channel message sent successfully (local-only): ${message.id}`)
      return message

    } catch (error) {
      debug.error('❌ MessageService: Failed to send channel message:', error)
      throw error
    }
  }

  // =====================================================
  // DM MESSAGES (SIMPLIFIED: TRUST DATABASE TRIGGERS)
  // =====================================================

  /**
   * Send a DM message (simplified: database triggers handle federation)
   *
   * @param options.isSystem - If true, stores as system message (not federated)
   * @param options.allowPlaintextFallback - explicit, user-confirmed opt-in
   *   to send plaintext into a conversation that's marked encrypted when
   *   encryption is unavailable. Default is fail-closed.
   */
  async sendDMMessage(
    conversationId: string,
    content: MessagePart[],
    replyTo?: string,
    options?: { isSystem?: boolean; allowPlaintextFallback?: boolean },
    extraMetadata?: Record<string, any>
  ): Promise<Message> {
    try {
      debug.log(`🚀 MessageService: Sending DM message to conversation: ${conversationId}`)

      const message = await coreMessageService.sendDMMessage(conversationId, content, replyTo, options, extraMetadata)

      debug.log(`✅ MessageService: DM message sent successfully - database handling federation: ${message.id}`)
      return message

    } catch (error) {
      debug.error('❌ MessageService: Failed to send DM message:', error)
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
      debug.log(`🚀 MessageService: Editing message: ${messageId}`)

      // Just edit the message - database triggers handle federation automatically
      const message = await coreMessageService.editMessage(messageId, newContent)

      debug.log(`✅ MessageService: Message edited successfully - database handling federation: ${messageId}`)
      return message

    } catch (error) {
      debug.error('❌ MessageService: Failed to edit message:', error)
      throw error
    }
  }

  /**
   * Delete a message (simplified: database triggers handle federation)
   */
  async deleteMessage(messageId: string): Promise<void> {
    try {
      debug.log(`🚀 MessageService: Deleting message: ${messageId}`)

      // Just delete the message - database triggers handle federation automatically
      await coreMessageService.deleteMessage(messageId)

      debug.log(`✅ MessageService: Message deleted successfully - database handling federation: ${messageId}`)

    } catch (error) {
      debug.error('❌ MessageService: Failed to delete message:', error)
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
      debug.log(`🚀 MessageService: Toggling reaction for message: ${messageId}, emoji: ${emojiId}`)

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

      debug.log(`✅ MessageService: Message reaction toggled - database handling federation: ${response.added ? 'added' : 'removed'}`)
      return response

    } catch (error) {
      debug.error('❌ MessageService: Failed to toggle message reaction:', error)
      throw error
    }
  }

  /**
   * Check if a string is a valid UUID
   * Uses permissive regex to handle Supabase-generated UUIDs which may not strictly follow RFC 4122
   */
  private isValidUUID(str: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
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
      debug.log(`🚀 MessageService: Loading reactions for message: ${messageId}`)

      // Delegate to core service (no federation needed for reads)
      const reactions = await coreMessageService.getMessageReactions(messageId)

      debug.log(`✅ MessageService: Loaded ${reactions.length} reaction groups`)
      return reactions

    } catch (error) {
      debug.error('❌ MessageService: Failed to load message reactions:', error)
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
      debug.log(`🚀 MessageService: Loading reactions for ${messageIds.length} messages`)

      // Delegate to core service (optimized batch query)
      const reactions = await coreMessageService.getBatchMessageReactions(messageIds)

      debug.log(`✅ MessageService: Loaded batch reactions successfully`)
      return reactions

    } catch (error) {
      debug.error('❌ MessageService: Failed to load batch message reactions:', error)
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
      debug.log(`🚀 MessageService: Loading channel messages for: ${channelId}`)

      // Delegate to core service (no federation needed for reads)
      const messages = await coreMessageService.loadChannelMessages(channelId, options)

      // Transform core service response to match expected API
      const { limit = 50 } = options
      const hasMore = messages.length === limit
      const lastCreated = hasMore ? messages[messages.length - 1]?.created_at : undefined
      const nextCursor = lastCreated ? (typeof lastCreated === 'string' ? lastCreated : (lastCreated as Date).toISOString()) : undefined
      
      const result = {
        messages,
        hasMore,
        nextCursor
      }

      debug.log(`✅ MessageService: Loaded ${messages.length} channel messages`)
      return result

    } catch (error) {
      debug.error('❌ MessageService: Failed to load channel messages:', error)
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
      debug.log(`🚀 MessageService: Loading conversation messages for: ${conversationId}`)

      // Delegate to core service (no federation needed for reads)
      const messages = await coreMessageService.loadConversationMessages(conversationId, options)

      // Transform core service response to match expected API
      const { limit = 50 } = options
      const hasMore = messages.length === limit
      const lastCreated = hasMore ? messages[messages.length - 1]?.created_at : undefined
      const nextCursor = lastCreated ? (typeof lastCreated === 'string' ? lastCreated : (lastCreated as Date).toISOString()) : undefined
      
      const result = {
        messages,
        hasMore,
        nextCursor
      }

      debug.log(`✅ MessageService: Loaded ${messages.length} conversation messages`)
      return result

    } catch (error) {
      debug.error('❌ MessageService: Failed to load conversation messages:', error)
      throw error
    }
  }

  /**
   * Load a single message (delegated to core service)
   * PRESERVES: Exact same API and return type
   */
  async loadMessage(messageId: string): Promise<Message | null> {
    try {
      debug.log(`🚀 MessageService: Loading message: ${messageId}`)

      // Delegate to core service (no federation needed for reads)
      const message = await coreMessageService.loadMessage(messageId)

      if (message) {
        debug.log(`✅ MessageService: Message loaded successfully: ${messageId}`)
      } else {
        debug.log(`ℹ️ MessageService: Message not found: ${messageId}`)
      }

      return message

    } catch (error) {
      debug.error('❌ MessageService: Failed to load message:', error)
      throw error
    }
  }

  // =====================================================
  // MESSAGE PINNING
  // =====================================================

  /**
   * Pin a message in a channel or DM
   */
  async pinMessage(messageId: string): Promise<boolean> {
    try {
      debug.log(`📌 Pinning message: ${messageId}`)

      const { data, error } = await supabase.rpc('pin_message', {
        p_message_id: messageId,
      })

      if (error) {
        debug.error('Failed to pin message:', error)
        throw this.createError('PIN_FAILED', error.message)
      }

      debug.log(`✅ Message pinned successfully: ${messageId}`)
      return true
    } catch (error) {
      debug.error('❌ Failed to pin message:', error)
      throw error
    }
  }

  /**
   * Unpin a message
   */
  async unpinMessage(messageId: string): Promise<boolean> {
    try {
      debug.log(`📌 Unpinning message: ${messageId}`)

      const { data, error } = await supabase.rpc('unpin_message', {
        p_message_id: messageId,
      })

      if (error) {
        debug.error('Failed to unpin message:', error)
        throw this.createError('UNPIN_FAILED', error.message)
      }

      debug.log(`✅ Message unpinned successfully: ${messageId}`)
      return true
    } catch (error) {
      debug.error('❌ Failed to unpin message:', error)
      throw error
    }
  }

  /**
   * Get pinned messages for a channel
   */
  async getPinnedChannelMessages(channelId: string): Promise<Message[]> {
    try {
      debug.log(`📌 Loading pinned messages for channel: ${channelId}`)

      // Use direct query - fetch messages first, then get author info separately
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('channel_id', channelId)
        .eq('is_pinned', true)
        .eq('is_deleted', false)
        .order('pinned_at', { ascending: false })

      if (error) {
        debug.error('Failed to load pinned messages:', error)
        throw this.createError('LOAD_PINS_FAILED', error.message)
      }

      // Transform to Message type - author info will be fetched by the component via useUserData
      const messages = (data || []).map((m: any) => ({
        id: m.id,
        created_at: new Date(m.created_at),
        channel_id: m.channel_id,
        conversation_id: m.conversation_id,
        user_id: m.user_id,
        content: m.content,
        reply_to: m.reply_to,
        is_pinned: m.is_pinned,
        pinned_at: m.pinned_at,
        pinned_by: m.pinned_by,
        metadata: m.metadata || {},
      }))

      debug.log(`✅ Loaded ${messages.length} pinned messages`)
      return messages
    } catch (error) {
      debug.error('❌ Failed to load pinned messages:', error)
      throw error
    }
  }

  /**
   * Get pinned messages for a DM conversation
   */
  async getPinnedDMMessages(conversationId: string): Promise<Message[]> {
    try {
      debug.log(`📌 Loading pinned messages for DM: ${conversationId}`)

      // Use direct query - author info will be fetched by the component
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .eq('is_pinned', true)
        .eq('is_deleted', false)
        .order('pinned_at', { ascending: false })

      if (error) {
        debug.error('Failed to load pinned DM messages:', error)
        throw this.createError('LOAD_PINS_FAILED', error.message)
      }

      // Transform to Message type - author info will be fetched by the component
      const messages = (data || []).map((m: any) => ({
        id: m.id,
        created_at: new Date(m.created_at),
        channel_id: m.channel_id,
        conversation_id: m.conversation_id,
        user_id: m.user_id,
        content: m.content,
        reply_to: m.reply_to,
        is_pinned: m.is_pinned,
        pinned_at: m.pinned_at,
        pinned_by: m.pinned_by,
        metadata: m.metadata || {},
      }))

      debug.log(`✅ Loaded ${messages.length} pinned DM messages`)
      return messages
    } catch (error) {
      debug.error('❌ Failed to load pinned DM messages:', error)
      throw error
    }
  }

  /**
   * Get pinned message count
   */
  async getPinnedCount(channelId?: string, conversationId?: string): Promise<number> {
    try {
      const { data, error } = await supabase.rpc('count_pinned_messages', {
        p_channel_id: channelId || null,
        p_conversation_id: conversationId || null,
      })

      if (error) throw error
      return data || 0
    } catch (error) {
      debug.error('Failed to get pinned count:', error)
      return 0
    }
  }

  // =====================================================
  // UTILITY METHODS (PRESERVED)
  // =====================================================

  /**
   * OPTIMIZED: Uses AuthContextService for cached profile ID lookup
   */
  private async getCurrentUserProfileId(): Promise<string> {
    const { authContextService } = await import('@/services/AuthContextService')
    
    try {
      return await authContextService.getCurrentProfileId()
    } catch {
      throw this.createError('AUTH_REQUIRED', 'User not authenticated')
    }
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