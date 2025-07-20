/**
 * CoreMessageService - Pure database operations for messages
 * 
 * SIMPLIFIED: Trust database RLS completely
 * - ✅ No auth checks (RLS handles security)
 * - ✅ No federation logic (database triggers handle it)
 * - ✅ Clean and simple
 */

import { supabase } from '@/supabase'
import type { Message, MessagePart } from '@/types'

/**
 * CoreMessageService - Pure database operations for messages
 * 
 * SIMPLIFIED: Trust database RLS completely
 * - ✅ No auth checks (RLS handles security)
 * - ✅ No federation logic (database triggers handle it)
 * - ✅ Clean and simple
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
   * Send a channel message - Database RLS handles everything
   */
  async sendChannelMessage(
    channelId: string,
    content: MessagePart[],
    replyTo?: string
  ): Promise<Message> {
    try {
      const messageData = {
        channel_id: channelId,
        content: content,
        reply_to: replyTo || null,
        metadata: { created_via: 'harmony_client' }
      }

      // Database RLS will set user_id and handle all security
      // Database triggers will handle federation automatically
      const { data: message, error } = await supabase
        .from('messages')
        .insert(messageData)
        .select('*')
        .single()

      if (error) throw this.createError('INSERT_FAILED', error.message, error)

      console.log('✅ Channel message sent - triggers handle federation')
      return message
    } catch (error) {
      console.error('❌ Failed to send channel message:', error)
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

      const { data: messages, error } = await query

      if (error) throw this.createError('LOAD_FAILED', error.message, error)

      console.log(`✅ Loaded ${messages?.length || 0} channel messages`)
      return messages || []
    } catch (error) {
      console.error('❌ Failed to load channel messages:', error)
      throw error
    }
  }

  // =====================================================
  // DM MESSAGES (TRUST DATABASE RLS)
  // =====================================================

  /**
   * Send a DM message - Database RLS handles everything
   */
  async sendDMMessage(
    conversationId: string,
    content: MessagePart[],
    replyTo?: string
  ): Promise<Message> {
    try {
      const messageData = {
        conversation_id: conversationId,
        content: content,
        reply_to: replyTo || null,
        metadata: { created_via: 'harmony_client' }
      }

      // Database RLS will set user_id and handle all security
      // Database triggers will handle federation automatically
      const { data: message, error } = await supabase
        .from('messages')
        .insert(messageData)
        .select('*')
        .single()

      if (error) throw this.createError('INSERT_FAILED', error.message, error)

      console.log('✅ DM message sent - triggers handle federation')
      return message
    } catch (error) {
      console.error('❌ Failed to send DM message:', error)
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

      const { data: messages, error } = await query

      if (error) throw this.createError('LOAD_FAILED', error.message, error)

      console.log(`✅ Loaded ${messages?.length || 0} conversation messages`)
      return messages || []
    } catch (error) {
      console.error('❌ Failed to load conversation messages:', error)
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
      const { error } = await supabase
        .from('messages')
        .delete()
        .eq('id', messageId)

      if (error) throw this.createError('DELETE_FAILED', error.message, error)

      console.log('✅ Message deleted successfully')
    } catch (error) {
      console.error('❌ Failed to delete message:', error)
      throw error
    }
  }

  /**
   * Edit a message - Database RLS ensures ownership
   */
  async editMessage(messageId: string, content: MessagePart[]): Promise<Message> {
    try {
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

      console.log('✅ Message edited successfully')
      return updatedMessage
    } catch (error) {
      console.error('❌ Failed to edit message:', error)
      throw error
    }
  }

  /**
   * Get a single message by ID - Database RLS handles permissions
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
      console.error('❌ Failed to get message:', error)
      throw error
    }
  }

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

      console.log(`✅ Found ${messages?.length || 0} messages matching search`)
      return messages || []
    } catch (error) {
      console.error('❌ Failed to search messages:', error)
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