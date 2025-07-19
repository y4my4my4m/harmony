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

import { supabase } from '@/supabase'
import type { Message, MessagePart } from '@/types'

export interface SendMessageData {
  content: MessagePart[]
  reply_to?: string
  // For server messages
  channel_id?: string
  // For DMs  
  conversation_id?: string
}

export interface CoreMessageServiceError {
  code: string
  message: string
  details?: any
}

export class CoreMessageService {
  private static instance: CoreMessageService
  
  static getInstance(): CoreMessageService {
    if (!this.instance) {
      this.instance = new CoreMessageService()
    }
    return this.instance
  }

  // =====================================================
  // MESSAGE CREATION (PURE LOCAL)
  // =====================================================

  /**
   * Send a server channel message (pure local database operation)
   */
  async sendChannelMessage(
    serverId: string,
    channelId: string,
    content: MessagePart[],
    replyTo?: string
  ): Promise<Message> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

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

      console.log('✅ Channel message sent successfully (local only)')
      return message
    } catch (error) {
      console.error('❌ Failed to send channel message:', error)
      throw error
    }
  }

  /**
   * Send a DM message (pure local database operation)
   * Note: Federation handling is done by orchestrator service
   */
  async sendDMMessage(
    conversationId: string,
    content: MessagePart[],
    replyTo?: string
  ): Promise<Message> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

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

      console.log('✅ DM message sent successfully (local only)')
      return message
    } catch (error) {
      console.error('❌ Failed to send DM message:', error)
      throw error
    }
  }

  // =====================================================
  // MESSAGE EDITING (PURE LOCAL)
  // =====================================================

  /**
   * Edit a message (pure local update)
   */
  async editMessage(messageId: string, newContent: MessagePart[]): Promise<Message> {
    try {
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

      if (error) throw this.createError('UPDATE_FAILED', error.message, error)

      console.log('✅ Message edited successfully (local only)')
      return message
    } catch (error) {
      console.error('❌ Failed to edit message:', error)
      throw error
    }
  }

  /**
   * Delete a message (soft delete, pure local)
   */
  async deleteMessage(messageId: string): Promise<void> {
    try {
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

      const { error } = await supabase
        .from('messages')
        .update({ 
          content: [{ type: 'text', text: '[deleted]' }] as MessagePart[],
          is_deleted: true,
          updated_at: new Date().toISOString()
        })
        .eq('id', messageId)

      if (error) throw this.createError('DELETE_FAILED', error.message, error)

      console.log('✅ Message deleted successfully (local only)')
    } catch (error) {
      console.error('❌ Failed to delete message:', error)
      throw error
    }
  }

  // =====================================================
  // REACTION MANAGEMENT (PURE LOCAL)
  // =====================================================

  /**
   * Toggle emoji reaction on a message (pure local database operation)
   */
  async toggleReaction(
    messageId: string, 
    emojiId: string
  ): Promise<{ added: boolean; hadRaceCondition?: boolean }> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      console.log(`🔄 Core: Toggling reaction: message=${messageId}, emoji=${emojiId}, user=${profileId}`)

      // Check if reaction already exists
      const { data: existingReaction } = await supabase
        .from('reactions')
        .select('id')
        .match({ message_id: messageId, emoji_id: emojiId, user_id: profileId })
        .maybeSingle()

      if (existingReaction) {
        // Remove reaction
        const { error } = await supabase
          .from('reactions')
          .delete()
          .match({ message_id: messageId, emoji_id: emojiId, user_id: profileId })

        if (error) throw this.createError('REMOVE_REACTION_FAILED', error.message, error)
        
        console.log('✅ Core: Reaction removed successfully')
        return { added: false }
      } else {
        // Add reaction
        const { error } = await supabase
          .from('reactions')
          .insert([{ 
            message_id: messageId, 
            emoji_id: emojiId,
            user_id: profileId,
          }])

        if (error) {
          // Handle race condition (duplicate constraint violation)
          if (error.code === '23505') {
            console.log('🎯 Core: Race condition detected in reaction toggle')
            
            // Double-check current state after race condition
            const { data: nowExists } = await supabase
              .from('reactions')
              .select('id')
              .match({ message_id: messageId, emoji_id: emojiId, user_id: profileId })
              .maybeSingle()

            if (nowExists) {
              console.log('✅ Core: Reaction was added by another process, treating as success')
              return { added: true, hadRaceCondition: true }
            } else {
              throw this.createError('RACE_CONDITION_ERROR', 'Unexpected duplicate error state')
            }
          }
          
          // Note: RLS policy issues should be resolved by migration 007's SECURITY DEFINER functions
          
          throw this.createError('ADD_REACTION_FAILED', error.message, error)
        }
        
        console.log('✅ Core: Reaction added successfully')
        return { added: true }
      }
    } catch (error) {
      console.error('❌ Core: Failed to toggle reaction:', error)
      throw error
    }
  }

  /**
   * Get reactions for a message using optimized database function (pure local)
   */
  async getMessageReactions(messageId: string): Promise<any[]> {
    try {
      console.log(`🔄 Core: Fetching reactions for message: ${messageId}`)
      
      const { data: reactions, error } = await supabase
        .rpc('get_message_reactions', { message_id: messageId })

      if (error) {
        console.error('❌ Core: Failed to fetch message reactions:', error)
        throw this.createError('FETCH_REACTIONS_FAILED', error.message, error)
      }

      console.log(`✅ Core: Fetched ${reactions?.length || 0} reaction groups for message: ${messageId}`)
      return reactions || []
    } catch (error) {
      console.error('❌ Core: Error in getMessageReactions:', error)
      throw error
    }
  }

  /**
   * Get reactions for multiple messages using optimized database function (pure local)
   * PERFORMANCE: Uses database function to eliminate N+1 query problem
   */
  private async getBatchMessageReactions(messageIds: string[]): Promise<Record<string, any[]>> {
    try {
      if (messageIds.length === 0) {
        return {}
      }

      console.log(`🔄 Core: Batch fetching reactions for ${messageIds.length} messages`)
      
      // Use the optimized database function
      const { data: reactions, error } = await supabase
        .rpc('get_batch_message_reactions', { message_ids: messageIds })

      if (error) {
        console.error('❌ Core: Failed to batch fetch message reactions:', error)
        throw this.createError('BATCH_FETCH_REACTIONS_FAILED', error.message, error)
      }

      // Group reactions by message_id
      const groupedReactions: Record<string, any[]> = {}
      
      // Initialize all message IDs with empty arrays
      messageIds.forEach(messageId => {
        groupedReactions[messageId] = []
      })

      // Group reactions by message
      reactions?.forEach(reaction => {
        const messageId = reaction.message_id
        
        if (!groupedReactions[messageId]) {
          groupedReactions[messageId] = []
        }
        
        groupedReactions[messageId].push({
          emoji_id: reaction.emoji_id,
          emoji: {
            id: reaction.emoji_id,
            name: reaction.emoji_name,
            url: reaction.emoji_url
          },
          count: reaction.reaction_count,
          users: reaction.users
        })
      })

      console.log(`✅ Core: Batch fetched reactions for ${messageIds.length} messages (${reactions?.length || 0} reaction groups)`)
      return groupedReactions
    } catch (error) {
      console.error('❌ Core: Error in getBatchMessageReactions:', error)
      throw error
    }
  }

  // =====================================================
  // MESSAGE LOADING (PURE LOCAL)
  // =====================================================

  /**
   * Load channel messages with pagination and reactions (pure local)
   * PERFORMANCE: Automatically loads reactions with messages to prevent N+1 queries
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
      const { limit = 50, before, after, signal } = options

      console.log(`🔄 Core: Loading messages for channel: ${channelId}`)

      let query = supabase
        .from('messages')
        .select('*')
        .eq('channel_id', channelId)
        .or('is_deleted.is.null,is_deleted.eq.false')
        .order('created_at', { ascending: false })
        .limit(limit)

      if (before) {
        query = query.lt('created_at', before)
      }
      if (after) {
        query = query.gt('created_at', after)
      }

      if (signal?.aborted) {
        throw this.createError('ABORTED', 'Request was aborted')
      }

      const { data: messages, error } = await query

      if (error) throw this.createError('LOAD_MESSAGES_FAILED', error.message, error)

      const messageList = messages || []

      // PERFORMANCE OPTIMIZATION: Batch load reactions for all messages
      if (messageList.length > 0) {
        const messageIds = messageList.map(m => m.id)
        const reactionsByMessage = await this.getBatchMessageReactions(messageIds)
        
        // Attach reactions to each message
        messageList.forEach(message => {
          message.reactions = reactionsByMessage[message.id] || []
        })
      }

      console.log(`✅ Core: Loaded ${messageList.length} messages with reactions for channel: ${channelId}`)
      return messageList
    } catch (error) {
      console.error('❌ Core: Failed to load channel messages:', error)
      throw error
    }
  }

  /**
   * Load conversation messages with pagination (pure local)
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
      const { limit = 50, before, after, signal } = options

      console.log(`🔄 Core: Loading messages for conversation: ${conversationId}`)

      let query = supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .or('is_deleted.is.null,is_deleted.eq.false')
        .order('created_at', { ascending: false })
        .limit(limit)

      if (before) {
        query = query.lt('created_at', before)
      }
      if (after) {
        query = query.gt('created_at', after)
      }

      if (signal?.aborted) {
        throw this.createError('ABORTED', 'Request was aborted')
      }

      const { data: messages, error } = await query

      if (error) throw this.createError('LOAD_MESSAGES_FAILED', error.message, error)

      const messageList = messages || []

      // PERFORMANCE OPTIMIZATION: Batch load reactions for all messages
      if (messageList.length > 0) {
        const messageIds = messageList.map(m => m.id)
        const reactionsByMessage = await this.getBatchMessageReactions(messageIds)
        
        // Attach reactions to each message
        messageList.forEach(message => {
          message.reactions = reactionsByMessage[message.id] || []
        })
      }

      console.log(`✅ Core: Loaded ${messageList.length} messages with reactions for conversation: ${conversationId}`)
      return messageList
    } catch (error) {
      console.error('❌ Core: Failed to load conversation messages:', error)
      throw error
    }
  }

  /**
   * Load a single message by ID (pure local)
   */
  async loadMessage(messageId: string): Promise<Message | null> {
    try {
      console.log(`🔄 Core: Loading message: ${messageId}`)

      const { data: message, error } = await supabase
        .from('messages')
        .select('*')
        .eq('id', messageId)
        .single()

      if (error) {
        if (error.code === 'PGRST116') {
          console.log(`ℹ️ Core: Message not found: ${messageId}`)
          return null
        }
        throw this.createError('LOAD_MESSAGE_FAILED', error.message, error)
      }

      console.log(`✅ Core: Loaded message: ${messageId}`)
      return message
    } catch (error) {
      console.error('❌ Core: Failed to load message:', error)
      throw error
    }
  }

  // =====================================================
  // HELPER METHODS (PURE LOCAL)
  // =====================================================

  private async getCurrentUserProfileId(): Promise<string> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('auth_user_id', user.id)
        .single()

      if (!profile) throw this.createError('PROFILE_NOT_FOUND', 'User profile not found')

      return profile.id
    } catch (error) {
      console.error('❌ Core: Failed to get current user profile ID:', error)
      throw error
    }
  }

  private createError(code: string, message: string, details?: any): CoreMessageServiceError {
    return { code, message, details }
  }
}

// Export singleton instance
export const coreMessageService = CoreMessageService.getInstance()