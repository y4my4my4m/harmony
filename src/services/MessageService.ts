/**
 * MessageService - Local-first message management
 * 
 * Handles messages, DMs, and reactions with local-first design:
 * - Immediate UI updates with optimistic actions
 * - Background federation for DMs only (not server messages)
 * - Unified handling for both server messages and DMs
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
  // MESSAGE SENDING (LOCAL-FIRST)
  // =====================================================

  /**
   * Send a server channel message (local-first)
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
        channel_id: channelId,
        user_id: profileId,
        content: content,
        reply_to: replyTo || null,
        is_system: false,
        is_edited: false
      }

      // Insert message - triggers will handle notifications (but not federation for server messages)
      const { data: insertedMessage, error } = await supabase
        .from('messages')
        .insert(messageData)
        .select(`
          *,
          user:profiles!user_id (
            id, username, display_name, avatar_url, domain, is_local,
            bio, created_at, updated_at
          ),
          reply_to_message:messages!reply_to (
            id, content, created_at,
            user:profiles!user_id (username, display_name, avatar_url)
          )
        `)
        .single()

      if (error) throw this.createError('SEND_FAILED', error.message, error)

      return this.transformDatabaseMessage(insertedMessage)
    } catch (error) {
      console.error('Failed to send channel message:', error)
      throw error
    }
  }

  /**
   * Send a DM message (local-first with federation)
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
        conversation_id: conversationId,
        user_id: profileId,
        content: content,
        reply_to: replyTo || null,
        is_system: false,
        is_edited: false
      }

      // Insert message - triggers will handle notifications AND federation for DMs
      const { data: insertedMessage, error } = await supabase
        .from('messages')
        .insert(messageData)
        .select(`
          *,
          user:profiles!user_id (
            id, username, display_name, avatar_url, domain, is_local,
            bio, created_at, updated_at
          ),
          reply_to_message:messages!reply_to (
            id, content, created_at,
            user:profiles!user_id (username, display_name, avatar_url)
          )
        `)
        .single()

      if (error) throw this.createError('SEND_FAILED', error.message, error)

      return this.transformDatabaseMessage(insertedMessage)
    } catch (error) {
      console.error('Failed to send DM message:', error)
      throw error
    }
  }

  /**
   * Edit a message (local-first)
   */
  async editMessage(messageId: string, newContent: MessagePart[]): Promise<Message> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      // Verify ownership
      const { data: existingMessage, error: fetchError } = await supabase
        .from('messages')
        .select('user_id')
        .eq('id', messageId)
        .single()

      if (fetchError || !existingMessage) {
        throw this.createError('MESSAGE_NOT_FOUND', 'Message not found')
      }

      if (existingMessage.user_id !== profileId) {
        throw this.createError('NOT_AUTHORIZED', 'You can only edit your own messages')
      }

      // Update message
      const { data: updatedMessage, error } = await supabase
        .from('messages')
        .update({
          content: newContent,
          is_edited: true,
          edited_at: new Date().toISOString()
        })
        .eq('id', messageId)
        .select(`
          *,
          user:profiles!user_id (
            id, username, display_name, avatar_url, domain, is_local,
            bio, created_at, updated_at
          ),
          reply_to_message:messages!reply_to (
            id, content, created_at,
            user:profiles!user_id (username, display_name, avatar_url)
          )
        `)
        .single()

      if (error) throw this.createError('EDIT_FAILED', error.message, error)

      return this.transformDatabaseMessage(updatedMessage)
    } catch (error) {
      console.error('Failed to edit message:', error)
      throw error
    }
  }

  /**
   * Delete a message (local-first)
   */
  async deleteMessage(messageId: string): Promise<void> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      // Verify ownership
      const { data: existingMessage, error: fetchError } = await supabase
        .from('messages')
        .select('user_id')
        .eq('id', messageId)
        .single()

      if (fetchError || !existingMessage) {
        throw this.createError('MESSAGE_NOT_FOUND', 'Message not found')
      }

      if (existingMessage.user_id !== profileId) {
        throw this.createError('NOT_AUTHORIZED', 'You can only delete your own messages')
      }

      // Soft delete
      const { error } = await supabase
        .from('messages')
        .update({
          is_deleted: true,
          deleted_at: new Date().toISOString()
        })
        .eq('id', messageId)

      if (error) throw this.createError('DELETE_FAILED', error.message, error)
    } catch (error) {
      console.error('Failed to delete message:', error)
      throw error
    }
  }

  // =====================================================
  // MESSAGE REACTIONS (LOCAL-FIRST)
  // =====================================================

  /**
   * Add/remove reaction to a message (local-first)
   */
  async toggleReaction(messageId: string, emoji: string): Promise<{ added: boolean }> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      // Check if reaction already exists
      const { data: existingReaction } = await supabase
        .from('reactions')
        .select('id')
        .eq('message_id', messageId)
        .eq('user_id', profileId)
        .eq('emoji', emoji)
        .maybeSingle()

      let added: boolean

      if (existingReaction) {
        // Remove reaction
        const { error } = await supabase
          .from('reactions')
          .delete()
          .eq('id', existingReaction.id)

        if (error) throw this.createError('REMOVE_REACTION_FAILED', error.message, error)
        added = false
      } else {
        // Add reaction
        const { error } = await supabase
          .from('reactions')
          .insert({
            message_id: messageId,
            user_id: profileId,
            emoji: emoji
          })

        if (error) throw this.createError('ADD_REACTION_FAILED', error.message, error)
        added = true
      }

      return { added }
    } catch (error) {
      console.error('Failed to toggle reaction:', error)
      throw error
    }
  }

  /**
   * Get reactions for a message
   */
  async getMessageReactions(messageId: string): Promise<any[]> {
    try {
      const { data: reactions, error } = await supabase
        .from('reactions')
        .select(`
          *,
          user:profiles!user_id (
            id, username, display_name, avatar_url
          )
        `)
        .eq('message_id', messageId)
        .order('created_at', { ascending: true })

      if (error) throw this.createError('LOAD_REACTIONS_FAILED', error.message, error)

      return reactions || []
    } catch (error) {
      console.error('Failed to load message reactions:', error)
      throw error
    }
  }

  // =====================================================
  // MESSAGE LOADING & QUERIES
  // =====================================================

  /**
   * Load messages for a channel with pagination
   */
  async loadChannelMessages(
    channelId: string,
    limit: number = 50,
    before?: string
  ): Promise<{ messages: Message[]; hasMore: boolean }> {
    try {
      let query = supabase
        .from('messages')
        .select(`
          *,
          user:profiles!user_id (
            id, username, display_name, avatar_url, domain, is_local,
            bio, created_at, updated_at
          ),
          reply_to_message:messages!reply_to (
            id, content, created_at,
            user:profiles!user_id (username, display_name, avatar_url)
          )
        `)
        .eq('channel_id', channelId)
        .eq('is_deleted', false)
        .order('created_at', { ascending: false })
        .limit(limit + 1) // +1 to check if there are more

      // Apply cursor pagination
      if (before) {
        query = query.lt('created_at', before)
      }

      const { data: messages, error } = await query

      if (error) throw this.createError('LOAD_FAILED', error.message, error)

      const hasMore = messages.length > limit
      const resultMessages = hasMore ? messages.slice(0, limit) : messages

      // Reverse to get chronological order (oldest first)
      resultMessages.reverse()

      return {
        messages: resultMessages.map(msg => this.transformDatabaseMessage(msg)),
        hasMore
      }
    } catch (error) {
      console.error('Failed to load channel messages:', error)
      throw error
    }
  }

  /**
   * Load messages for a DM conversation with pagination
   */
  async loadConversationMessages(
    conversationId: string,
    limit: number = 50,
    before?: string
  ): Promise<{ messages: Message[]; hasMore: boolean }> {
    try {
      let query = supabase
        .from('messages')
        .select(`
          *,
          user:profiles!user_id (
            id, username, display_name, avatar_url, domain, is_local,
            bio, created_at, updated_at
          ),
          reply_to_message:messages!reply_to (
            id, content, created_at,
            user:profiles!user_id (username, display_name, avatar_url)
          )
        `)
        .eq('conversation_id', conversationId)
        .eq('is_deleted', false)
        .order('created_at', { ascending: false })
        .limit(limit + 1) // +1 to check if there are more

      // Apply cursor pagination
      if (before) {
        query = query.lt('created_at', before)
      }

      const { data: messages, error } = await query

      if (error) throw this.createError('LOAD_FAILED', error.message, error)

      const hasMore = messages.length > limit
      const resultMessages = hasMore ? messages.slice(0, limit) : messages

      // Reverse to get chronological order (oldest first)
      resultMessages.reverse()

      return {
        messages: resultMessages.map(msg => this.transformDatabaseMessage(msg)),
        hasMore
      }
    } catch (error) {
      console.error('Failed to load conversation messages:', error)
      throw error
    }
  }

  /**
   * Load a single message with context
   */
  async loadMessage(messageId: string): Promise<Message | null> {
    try {
      const { data: message, error } = await supabase
        .from('messages')
        .select(`
          *,
          user:profiles!user_id (
            id, username, display_name, avatar_url, domain, is_local,
            bio, created_at, updated_at
          ),
          reply_to_message:messages!reply_to (
            id, content, created_at,
            user:profiles!user_id (username, display_name, avatar_url)
          )
        `)
        .eq('id', messageId)
        .eq('is_deleted', false)
        .single()

      if (error) {
        if (error.code === 'PGRST116') return null // Not found
        throw this.createError('LOAD_FAILED', error.message, error)
      }

      return this.transformDatabaseMessage(message)
    } catch (error) {
      console.error('Failed to load message:', error)
      throw error
    }
  }

  // =====================================================
  // HELPER METHODS
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

  private transformDatabaseMessage(message: any): Message {
    // Ensure content is properly formatted as MessagePart[]
    let processedContent = message.content
    if (typeof message.content === 'string') {
      try {
        const parsed = JSON.parse(message.content)
        if (Array.isArray(parsed)) {
          processedContent = parsed
        } else {
          processedContent = [{ type: 'text', text: message.content }]
        }
      } catch {
        processedContent = [{ type: 'text', text: message.content }]
      }
    } else if (!Array.isArray(message.content)) {
      processedContent = [{ type: 'text', text: '' }]
    }

    return {
      id: message.id,
      created_at: message.created_at,
      updated_at: message.updated_at || message.created_at,
      content: processedContent,
      user_id: message.user_id,
      channel_id: message.channel_id,
      conversation_id: message.conversation_id,
      reply_to: message.reply_to,
      is_system: message.is_system || false,
      is_edited: message.is_edited || false,
      edited_at: message.edited_at,
      is_deleted: message.is_deleted || false,
      deleted_at: message.deleted_at,
      metadata: message.metadata || {},
      user: message.user ? {
        id: message.user.id,
        username: message.user.username,
        display_name: message.user.display_name || message.user.username,
        avatar_url: message.user.avatar_url || '/default_avatar.png',
        domain: message.user.domain || 'har.mony.lol',
        bio: message.user.bio || '',
        is_local: message.user.is_local !== false,
        created_at: message.user.created_at,
        updated_at: message.user.updated_at || message.user.created_at
      } : {
        id: message.user_id,
        username: 'Unknown',
        display_name: 'Unknown User',
        avatar_url: '/default_avatar.png',
        domain: 'har.mony.lol',
        bio: '',
        is_local: true,
        created_at: message.created_at,
        updated_at: message.created_at
      },
      reply_to_message: message.reply_to_message || undefined
    }
  }

  private createError(code: string, message: string, details?: any): MessageServiceError {
    return { code, message, details }
  }
}

// Export singleton instance
export const messageService = MessageService.getInstance()