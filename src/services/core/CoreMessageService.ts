/**
 * CoreMessageService - Pure database operations for messages
 * 
 * SIMPLIFIED DESIGN: Trust database RLS for security
 * - ✅ Minimal auth checks (only for UI state)
 * - ✅ Database RLS handles all security
 * - ✅ No federation logic (handled by database triggers)
 * - ✅ Clean error handling
 */

import { supabase } from '@/supabase'
import type { Message, MessagePart } from '@/types'
import { isAuthenticated } from '@/utils/authHelpers'

/**
 * CoreMessageService - Pure database operations for messages
 * 
 * SIMPLIFIED DESIGN: Trust database RLS for security
 * - ✅ Minimal auth checks (only for UI state)
 * - ✅ Database RLS handles all security
 * - ✅ No federation logic (handled by database triggers)
 * - ✅ Clean error handling
 */

interface MessageServiceError {
  code: string
  message: string
  details?: any
}

export class CoreMessageService {
  private static instance: CoreMessageService

  static getInstance(): CoreMessageService {
    if (!CoreMessageService.instance) {
      CoreMessageService.instance = new CoreMessageService()
    }
    return CoreMessageService.instance
  }

  private constructor() {}

  // =====================================================
  // CHANNEL MESSAGES (TRUST DATABASE RLS)
  // =====================================================

  /**
   * Send a channel message - Database RLS handles security
   */
  async sendChannelMessage(
    channelId: string,
    content: MessagePart[],
    replyTo?: string
  ): Promise<Message> {
    try {
      // Simple UI check - database RLS handles actual security
      if (!isAuthenticated()) {
        throw this.createError('AUTH_REQUIRED', 'User not authenticated')
      }

      // Use database function to insert with proper user_id
      const { data: message, error } = await supabase
        .rpc('create_channel_message', {
          p_channel_id: channelId,
          p_content: content,
          p_reply_to: replyTo || null
        })

      if (error) throw this.createError('INSERT_FAILED', error.message, error)

      // Get the full message with profile data
      const { data: fullMessage, error: fetchError } = await supabase
        .from('messages')
        .select(`
          *,
          profiles:user_id (
            id, username, display_name, avatar_url, color, status, domain, is_local
          )
        `)
        .eq('id', message)
        .single()

      if (fetchError) throw this.createError('FETCH_FAILED', fetchError.message, fetchError)

      console.log('✅ Channel message sent - database triggers handle federation')
      return fullMessage
    } catch (error) {
      console.error('❌ Core: Failed to send channel message:', error)
      throw error
    }
  }

  /**
   * Load channel messages - Database RLS handles permissions
   */
  async loadChannelMessages(
    channelId: string,
    options: {
      limit?: number
      before?: string
      after?: string
      signal?: AbortSignal
    } = {}
  ): Promise<Message[]> {
    try {
      const { limit = 50, before, after } = options

      let query = supabase
        .from('messages')
        .select(`
          *,
          profiles:user_id (
            id, username, display_name, avatar_url, color, status, domain, is_local
          )
        `)
        .eq('channel_id', channelId)
        .is('conversation_id', null)
        .order('created_at', { ascending: false })
        .limit(limit)

      if (before) {
        query = query.lt('created_at', before)
      }

      if (after) {
        query = query.gt('created_at', after)
      }

      // Database RLS ensures user can only see messages they have permission to see
      const { data: messages, error } = await query

      if (error) throw this.createError('LOAD_FAILED', error.message, error)

      console.log(`✅ Core: Loaded ${messages?.length || 0} channel messages`)
      return messages || []
    } catch (error) {
      console.error('❌ Core: Failed to load channel messages:', error)
      throw error
    }
  }

  // =====================================================
  // DM MESSAGES (TRUST DATABASE RLS)
  // =====================================================

  /**
   * Send a DM message - Database RLS handles security and triggers handle federation
   */
  async sendDMMessage(
    conversationId: string,
    content: MessagePart[],
    replyTo?: string
  ): Promise<Message> {
    try {
      // Simple UI check - database RLS handles actual security
      if (!isAuthenticated()) {
        throw this.createError('AUTH_REQUIRED', 'User not authenticated')
      }

      // Use database function to insert with proper user_id
      const { data: messageId, error } = await supabase
        .rpc('create_dm_message', {
          p_conversation_id: conversationId,
          p_content: content,
          p_reply_to: replyTo || null
        })

      if (error) throw this.createError('INSERT_FAILED', error.message, error)

      // Get the full message with profile data
      const { data: fullMessage, error: fetchError } = await supabase
        .from('messages')
        .select(`
          *,
          profiles:user_id (
            id, username, display_name, avatar_url, color, status, domain, federated_id, is_local
          )
        `)
        .eq('id', messageId)
        .single()

      if (fetchError) throw this.createError('FETCH_FAILED', fetchError.message, fetchError)

      console.log('✅ DM message sent - database triggers handle federation')
      return fullMessage
    } catch (error) {
      console.error('❌ Core: Failed to send DM message:', error)
      throw error
    }
  }

  /**
   * Load conversation messages - Database RLS handles permissions
   */
  async loadConversationMessages(
    conversationId: string,
    options: {
      limit?: number
      before?: string
      after?: string
      signal?: AbortSignal
    } = {}
  ): Promise<Message[]> {
    try {
      const { limit = 50, before, after } = options

      let query = supabase
        .from('messages')
        .select(`
          *,
          profiles:user_id (
            id, username, display_name, avatar_url, color, status, domain, federated_id, is_local
          )
        `)
        .eq('conversation_id', conversationId)
        .is('channel_id', null)
        .order('created_at', { ascending: false })
        .limit(limit)

      if (before) {
        query = query.lt('created_at', before)
      }

      if (after) {
        query = query.gt('created_at', after)
      }

      // Database RLS ensures user can only see conversations they're part of
      const { data: messages, error } = await query

      if (error) throw this.createError('LOAD_FAILED', error.message, error)

      console.log(`✅ Core: Loaded ${messages?.length || 0} conversation messages`)
      return messages || []
    } catch (error) {
      console.error('❌ Core: Failed to load conversation messages:', error)
      throw error
    }
  }

  // =====================================================
  // MESSAGE MANAGEMENT (TRUST DATABASE RLS)
  // =====================================================

  /**
   * Delete a message - Database RLS ensures ownership
   */
  async deleteMessage(messageId: string): Promise<void> {
    try {
      if (!isAuthenticated()) {
        throw this.createError('AUTH_REQUIRED', 'User not authenticated')
      }

      // Database RLS will ensure user can only delete their own messages
      const { error } = await supabase
        .from('messages')
        .delete()
        .eq('id', messageId)

      if (error) throw this.createError('DELETE_FAILED', error.message, error)

      console.log('✅ Core: Message deleted successfully')
    } catch (error) {
      console.error('❌ Core: Failed to delete message:', error)
      throw error
    }
  }

  /**
   * Edit a message - Database RLS ensures ownership
   */
  async editMessage(messageId: string, content: MessagePart[]): Promise<Message> {
    try {
      if (!isAuthenticated()) {
        throw this.createError('AUTH_REQUIRED', 'User not authenticated')
      }

      // Database RLS will ensure user can only edit their own messages
      const { data: updatedMessage, error } = await supabase
        .from('messages')
        .update({ 
          content,
          updated_at: new Date().toISOString()
        })
        .eq('id', messageId)
        .select('*')
        .single()

      if (error) throw this.createError('UPDATE_FAILED', error.message, error)

      console.log('✅ Core: Message edited successfully')
      return updatedMessage
    } catch (error) {
      console.error('❌ Core: Failed to edit message:', error)
      throw error
    }
  }

  /**
   * Get a single message by ID - Database RLS handles permissions
   */
  async getMessage(messageId: string): Promise<Message> {
    try {
      // Database RLS will ensure user can only see messages they have permission to see
      const { data: message, error } = await supabase
        .from('messages')
        .select(`
          *,
          profiles:user_id (
            id, username, display_name, avatar_url, color, status, domain, federated_id, is_local
          )
        `)
        .eq('id', messageId)
        .single()

      if (error) throw this.createError('MESSAGE_NOT_FOUND', error.message, error)

      return message
    } catch (error) {
      console.error('❌ Core: Failed to get message:', error)
      throw error
    }
  }

  // =====================================================
  // SEARCH AND FILTERING (TRUST DATABASE RLS)
  // =====================================================

  /**
   * Search messages in a channel - Database RLS handles permissions
   */
  async searchChannelMessages(
    channelId: string,
    query: string,
    options: {
      limit?: number
      offset?: number
    } = {}
  ): Promise<Message[]> {
    try {
      const { limit = 20, offset = 0 } = options

      // Database RLS will ensure user can only search messages they have permission to see
      const { data: messages, error } = await supabase
        .from('messages')
        .select(`
          *,
          profiles:user_id (
            id, username, display_name, avatar_url, color, status, domain, is_local
          )
        `)
        .eq('channel_id', channelId)
        .textSearch('content', query)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)

      if (error) throw this.createError('SEARCH_FAILED', error.message, error)

      console.log(`✅ Core: Found ${messages?.length || 0} messages matching search`)
      return messages || []
    } catch (error) {
      console.error('❌ Core: Failed to search messages:', error)
      throw error
    }
  }

  // =====================================================
  // HELPER METHODS
  // =====================================================

  private createError(code: string, message: string, details?: any): MessageServiceError {
    return {
      code,
      message,
      details
    }
  }
}

// Export singleton instance
export const coreMessageService = CoreMessageService.getInstance()