/**
 * MessageService - Professional message management using database functions
 * 
 * UPDATED: Now uses professional database functions for local-first operations
 * - send_message_professional(): Sends messages with automatic federation
 * - get_federation_status(): Gets comprehensive federation info in one call
 * 
 * PERFORMANCE BENEFITS:
 * - ✅ Single RPC call instead of multiple frontend calls
 * - ✅ Automatic federation handling in database triggers
 * - ✅ No manual federation checks needed
 * - ✅ Professional DRY architecture
 */

import { supabase } from '@/supabase'
import type { Message, MessagePart, ReactionGroup } from '@/types'

export interface SendMessageData {
  content: MessagePart[]
  reply_to?: string
  // For server messages
  channel_id?: string
  // For DMs  
  conversation_id?: string
}

export interface MessageServiceError {
  code: string
  message: string
  details?: any
}

export class MessageService {
  private static instance: MessageService
  
  static getInstance(): MessageService {
    if (!this.instance) {
      this.instance = new MessageService()
    }
    return this.instance
  }

  // =====================================================
  // MESSAGE SENDING (PROFESSIONAL DATABASE FUNCTIONS)
  // =====================================================

  /**
   * Send a server channel message (professional: single database call, local-only)
   */
  async sendChannelMessage(
    serverId: string,
    channelId: string,
    content: MessagePart[],
    replyTo?: string
  ): Promise<Message> {
    try {
      console.log(`🚀 Professional: Sending channel message to channel: ${channelId}`)

      // Get current user
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      // Single RPC call handles everything: local creation (no federation for server messages)
      const { data: messageResult, error } = await supabase
        .rpc('send_message_professional', {
          p_user_id: profileId,
          p_content: content,
          p_channel_id: channelId,
          p_conversation_id: null,
          p_reply_to: replyTo || null
        })

      if (error) throw this.createError('SEND_FAILED', error.message, error)

      console.log(`✅ Professional: Channel message sent successfully: ${messageResult.id}`)
      
      // Transform database response to expected format
      return {
        id: messageResult.id,
        content: messageResult.content,
        created_at: messageResult.created_at,
        updated_at: messageResult.updated_at,
        channel_id: messageResult.channel_id,
        conversation_id: messageResult.conversation_id,
        reply_to: messageResult.reply_to,
        is_system: messageResult.is_system,
        user: messageResult.user,
        metadata: messageResult.metadata || {}
      } as Message

    } catch (error) {
      console.error('❌ Professional: Failed to send channel message:', error)
      throw error
    }
  }

  /**
   * Send a DM message (professional: single database call with automatic federation)
   */
  async sendDMMessage(
    conversationId: string,
    content: MessagePart[],
    replyTo?: string
  ): Promise<Message> {
    try {
      console.log(`🚀 Professional: Sending DM message to conversation: ${conversationId}`)

      // Get current user
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      // Single RPC call handles everything: local creation + automatic federation for DMs
      const { data: messageResult, error } = await supabase
        .rpc('send_message_professional', {
          p_user_id: profileId,
          p_content: content,
          p_channel_id: null,
          p_conversation_id: conversationId,
          p_reply_to: replyTo || null
        })

      if (error) throw this.createError('SEND_FAILED', error.message, error)

      console.log(`✅ Professional: DM message sent successfully: ${messageResult.id}`)
      
      // Transform database response to expected format
      return {
        id: messageResult.id,
        content: messageResult.content,
        created_at: messageResult.created_at,
        updated_at: messageResult.updated_at,
        channel_id: messageResult.channel_id,
        conversation_id: messageResult.conversation_id,
        reply_to: messageResult.reply_to,
        is_system: messageResult.is_system,
        user: messageResult.user,
        metadata: messageResult.metadata || {}
      } as Message

    } catch (error) {
      console.error('❌ Professional: Failed to send DM message:', error)
      throw error
    }
  }

  /**
   * Edit a message (using existing logic for now)
   */
  async editMessage(messageId: string, newContent: MessagePart[]): Promise<Message> {
    try {
      console.log(`🚀 Professional: Editing message: ${messageId}`)

      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      // Verify ownership
      const { data: existingMessage } = await supabase
        .from('messages')
        .select('user_id')
        .eq('id', messageId)
        .single()

      if (existingMessage?.user_id !== profileId) {
        throw this.createError('UNAUTHORIZED', 'Cannot edit message you do not own')
      }

      const { data: message, error } = await supabase
        .from('messages')
        .update({ 
          content: newContent, 
          updated_at: new Date().toISOString() 
        })
        .eq('id', messageId)
        .select('*')
        .single()

      if (error) throw this.createError('EDIT_FAILED', error.message, error)

      console.log(`✅ Professional: Message edited successfully: ${messageId}`)
      return message

    } catch (error) {
      console.error('❌ Professional: Failed to edit message:', error)
      throw error
    }
  }

  /**
   * Delete a message (using existing logic for now)
   */
  async deleteMessage(messageId: string): Promise<void> {
    try {
      console.log(`🚀 Professional: Deleting message: ${messageId}`)

      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      // Verify ownership
      const { data: existingMessage } = await supabase
        .from('messages')
        .select('user_id')
        .eq('id', messageId)
        .single()

      if (existingMessage?.user_id !== profileId) {
        throw this.createError('UNAUTHORIZED', 'Cannot delete message you do not own')
      }

      // Soft delete
      const { error } = await supabase
        .from('messages')
        .update({ is_deleted: true })
        .eq('id', messageId)

      if (error) throw this.createError('DELETE_FAILED', error.message, error)

      console.log(`✅ Professional: Message deleted successfully: ${messageId}`)

    } catch (error) {
      console.error('❌ Professional: Failed to delete message:', error)
      throw error
    }
  }

  // =====================================================
  // REACTIONS (EXISTING LOGIC FOR NOW)
  // =====================================================

  /**
   * Toggle reaction (preserves existing API and race condition handling)
   */
  async toggleReaction(
    messageId: string, 
    emojiId: string, 
    options: {
      signal?: AbortSignal;
    } = {}
  ): Promise<{ added: boolean; hadRaceCondition?: boolean }> {
    try {
      console.log(`🚀 Professional: Toggling reaction: message=${messageId}, emoji=${emojiId}`)

      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      // Check current reaction status
      const { data: existingReaction } = await supabase
        .from('reactions')
        .select('id')
        .eq('message_id', messageId)
        .eq('user_id', profileId)
        .eq('emoji_id', emojiId)
        .single()

      let added: boolean
      if (existingReaction) {
        // Remove reaction
        const { error } = await supabase
          .from('reactions')
          .delete()
          .eq('id', existingReaction.id)

        if (error) {
          if (error.code === '23505') {
            console.log('⚠️ Professional: Race condition detected in reaction removal')
            return { added: false, hadRaceCondition: true }
          }
          throw this.createError('REMOVE_REACTION_FAILED', error.message, error)
        }
        added = false
      } else {
        // Add reaction
        const { error } = await supabase
          .from('reactions')
          .insert({
            message_id: messageId,
            user_id: profileId,
            emoji_id: emojiId
          })

        if (error) {
          if (error.code === '23505') {
            console.log('⚠️ Professional: Race condition detected in reaction addition')
            return { added: true, hadRaceCondition: true }
          }
          throw this.createError('ADD_REACTION_FAILED', error.message, error)
        }
        added = true
      }

      console.log(`✅ Professional: Reaction toggled successfully: ${added ? 'added' : 'removed'}`)
      return { added }

    } catch (error) {
      console.error('❌ Professional: Failed to toggle reaction:', error)
      throw error
    }
  }

  /**
   * Get message reactions (using existing logic)
   */
  async getMessageReactions(messageId: string): Promise<ReactionGroup[]> {
    try {
      console.log(`🚀 Professional: Loading reactions for message: ${messageId}`)

      // Use existing RPC function if available
      const { data: reactions, error } = await supabase
        .rpc('get_message_reactions', { p_message_id: messageId })

      if (error) throw this.createError('LOAD_REACTIONS_FAILED', error.message, error)

      console.log(`✅ Professional: Loaded ${reactions?.length || 0} reaction groups`)
      return reactions || []

    } catch (error) {
      console.error('❌ Professional: Failed to load reactions:', error)
      throw error
    }
  }

  // =====================================================
  // MESSAGE LOADING (DELEGATED TO EXISTING FUNCTIONS)
  // =====================================================

  /**
   * Load channel messages (using existing logic)
   */
  async loadChannelMessages(
    channelId: string,
    options: {
      limit?: number;
      before?: string;
      after?: string;
    } = {}
  ): Promise<{
    messages: Message[];
    hasMore: boolean;
    nextCursor?: string;
  }> {
    try {
      console.log(`🚀 Professional: Loading channel messages: ${channelId}`)

      const limit = options.limit || 50

      const query = supabase
        .from('messages')
        .select('*')
        .eq('channel_id', channelId)
        .order('created_at', { ascending: false })
        .limit(limit)

      if (options.before) {
        query.lt('created_at', options.before)
      }

      const { data: messages, error } = await query

      if (error) throw this.createError('LOAD_FAILED', error.message, error)

      const hasMore = messages.length === limit
      const nextCursor = hasMore ? messages[messages.length - 1]?.created_at : undefined

      console.log(`✅ Professional: Loaded ${messages.length} channel messages`)
      return { messages: messages || [], hasMore, nextCursor }

    } catch (error) {
      console.error('❌ Professional: Failed to load channel messages:', error)
      throw error
    }
  }

  /**
   * Load conversation messages (using existing logic)
   */
  async loadConversationMessages(
    conversationId: string,
    options: {
      limit?: number;
      before?: string;
      after?: string;
    } = {}
  ): Promise<{
    messages: Message[];
    hasMore: boolean;
    nextCursor?: string;
  }> {
    try {
      console.log(`🚀 Professional: Loading conversation messages: ${conversationId}`)

      const limit = options.limit || 50

      const query = supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(limit)

      if (options.before) {
        query.lt('created_at', options.before)
      }

      const { data: messages, error } = await query

      if (error) throw this.createError('LOAD_FAILED', error.message, error)

      const hasMore = messages.length === limit
      const nextCursor = hasMore ? messages[messages.length - 1]?.created_at : undefined

      console.log(`✅ Professional: Loaded ${messages.length} conversation messages`)
      return { messages: messages || [], hasMore, nextCursor }

    } catch (error) {
      console.error('❌ Professional: Failed to load conversation messages:', error)
      throw error
    }
  }

  /**
   * Load single message (using existing logic)
   */
  async loadMessage(messageId: string): Promise<Message | null> {
    try {
      console.log(`🚀 Professional: Loading message: ${messageId}`)
      
      const { data: message, error } = await supabase
        .from('messages')
        .select('*')
        .eq('id', messageId)
        .single()

      if (error) {
        if (error.code === 'PGRST116') {
          console.log(`ℹ️ Professional: Message not found: ${messageId}`)
          return null
        }
        throw this.createError('LOAD_FAILED', error.message, error)
      }
      
      console.log(`✅ Professional: Message loaded successfully: ${messageId}`)
      return message

    } catch (error) {
      console.error('❌ Professional: Failed to load message:', error)
      throw error
    }
  }

  // =====================================================
  // FEDERATION STATUS (PROFESSIONAL SINGLE CALL)
  // =====================================================

  /**
   * Get comprehensive federation status (replaces multiple frontend calls)
   */
  async getFederationStatus(): Promise<any> {
    try {
      console.log(`🚀 Professional: Getting federation status (single call)`)

      const { data: { user } } = await supabase.auth.getUser()
      
      const { data: status, error } = await supabase
        .rpc('get_federation_status', {
          p_user_id: user?.id || null
        })

      if (error) throw this.createError('FEDERATION_STATUS_FAILED', error.message, error)

      console.log(`✅ Professional: Federation status retrieved:`, status)
      return status

    } catch (error) {
      console.error('❌ Professional: Failed to get federation status:', error)
      throw error
    }
  }

  // =====================================================
  // HELPER METHODS
  // =====================================================

  private async getCurrentUserProfileId(): Promise<string> {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .single()

    if (!profile) throw this.createError('PROFILE_NOT_FOUND', 'User profile not found')
    return profile.id
  }

  private createError(code: string, message: string, details?: any): Error {
    const error = new Error(message)
    error.name = code
    if (details) {
      (error as any).details = details
    }
    return error
  }
}

// Export singleton instance
export const messageService = MessageService.getInstance()