/**
 * CoreMessageService - Pure database operations for messages
 * 
 * PERFORMANCE OPTIMIZED:
 * - ✅ Uses efficient auth helpers instead of supabase.auth.getUser()
 * - ✅ Minimal database queries 
 * - ✅ No federation logic (handled by database triggers)
 * - ✅ Clean error handling with typed errors
 * 
 * DESIGN PRINCIPLE: Trust database triggers for federation/notifications
 */

import { supabase } from '@/supabase'
import type { Message, MessagePart } from '@/types'
import { getCurrentUserProfileId, isAuthenticated } from '@/utils/authHelpers'

/**
 * CoreMessageService - Pure local message operations
 * 
 * Contains ONLY local database operations with NO federation logic:
 * - Message CRUD operations (create, read, update, delete)
 * - Reaction management (local database only)
 * - Message loading and pagination
 * - Validation and error handling
 * 
 * NO FEDERATION CONCERNS:
 * - No ap_activities insertions
 * - No federation condition checks
 * - No ActivityPub protocol handling
 * - Pure local Supabase operations only
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
  // CHANNEL MESSAGES (PURE LOCAL)
  // =====================================================

  /**
   * Send a channel message (pure local database operation)
   */
  async sendChannelMessage(
    channelId: string,
    content: MessagePart[],
    replyTo?: string
  ): Promise<Message> {
    try {
      if (!isAuthenticated()) {
        throw this.createError('AUTH_REQUIRED', 'User not authenticated')
      }

      const profileId = await getCurrentUserProfileId()

      const messageData = {
        user_id: profileId,
        channel_id: channelId,
        content: content,
        reply_to: replyTo || null,
        metadata: { created_via: 'harmony_client' }
      }

      const { data: message, error } = await supabase
        .from('messages')
        .insert(messageData)
        .select('*')
        .single()

      if (error) throw this.createError('INSERT_FAILED', error.message, error)

      console.log('✅ Channel message sent successfully')
      return message
    } catch (error) {
      console.error('❌ Core: Failed to send channel message:', error)
      throw error
    }
  }

  /**
   * Load channel messages with pagination
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
  // DM MESSAGES (PURE LOCAL)
  // =====================================================

  /**
   * Send a DM message (pure local database operation)
   * Note: Federation handling is done by database triggers
   */
  async sendDMMessage(
    conversationId: string,
    content: MessagePart[],
    replyTo?: string
  ): Promise<Message> {
    try {
      if (!isAuthenticated()) {
        throw this.createError('AUTH_REQUIRED', 'User not authenticated')
      }

      const profileId = await getCurrentUserProfileId()

      const messageData = {
        user_id: profileId,
        conversation_id: conversationId,
        content: content,
        reply_to: replyTo || null,
        metadata: { created_via: 'harmony_client' }
      }

      const { data: message, error } = await supabase
        .from('messages')
        .insert(messageData)
        .select('*')
        .single()

      if (error) throw this.createError('INSERT_FAILED', error.message, error)

      console.log('✅ DM message sent successfully - database triggers handle federation')
      return message
    } catch (error) {
      console.error('❌ Core: Failed to send DM message:', error)
      throw error
    }
  }

  /**
   * Load conversation messages with pagination  
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
  // MESSAGE MANAGEMENT (PURE LOCAL)
  // =====================================================

  /**
   * Delete a message
   */
  async deleteMessage(messageId: string): Promise<void> {
    try {
      if (!isAuthenticated()) {
        throw this.createError('AUTH_REQUIRED', 'User not authenticated')
      }

      const profileId = await getCurrentUserProfileId()

      // Verify ownership
      const { data: message, error: fetchError } = await supabase
        .from('messages')
        .select('user_id')
        .eq('id', messageId)
        .single()

      if (fetchError) throw this.createError('MESSAGE_NOT_FOUND', fetchError.message, fetchError)

      if (message.user_id !== profileId) {
        throw this.createError('UNAUTHORIZED', 'Cannot delete message from another user')
      }

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
   * Edit a message
   */
  async editMessage(messageId: string, content: MessagePart[]): Promise<Message> {
    try {
      if (!isAuthenticated()) {
        throw this.createError('AUTH_REQUIRED', 'User not authenticated')
      }

      const profileId = await getCurrentUserProfileId()

      // Verify ownership
      const { data: message, error: fetchError } = await supabase
        .from('messages')
        .select('user_id')
        .eq('id', messageId)
        .single()

      if (fetchError) throw this.createError('MESSAGE_NOT_FOUND', fetchError.message, fetchError)

      if (message.user_id !== profileId) {
        throw this.createError('UNAUTHORIZED', 'Cannot edit message from another user')
      }

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
   * Get a single message by ID
   */
  async getMessage(messageId: string): Promise<Message> {
    try {
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
  // SEARCH AND FILTERING (PURE LOCAL)
  // =====================================================

  /**
   * Search messages in a channel
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
  // HELPER METHODS (OPTIMIZED)
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