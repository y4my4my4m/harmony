/** Message operations; delegates to CoreMessageService. */
import { supabase } from '@/supabase'
import type { Message, MessagePart } from '@/types'
import { debug } from '@/utils/debug'

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

// Re-exported so callers need not import from the core layer.
export type { SendOptions }

export class MessageService {
  private static instance: MessageService

  static getInstance(): MessageService {
    if (!MessageService.instance) {
      MessageService.instance = new MessageService()
    }
    return MessageService.instance
  }

  /**
   * Server channels are not federated.
   *
   * `options.allowPlaintextFallback` permits plaintext when the channel is
   * encryption-eligible but encryption is unavailable. Default is
   * fail-closed: callers catch ENCRYPTION_* errors and confirm with the user
   * before retrying with the override.
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
      debug.log(`MessageService: Sending channel message to: ${channelId}`)

      // Channel messages are local-only; no federation.
      const message = await coreMessageService.sendChannelMessage(serverId, channelId, content, replyTo, extraMetadata, options)

      debug.log(`MessageService: Channel message sent successfully (local-only): ${message.id}`)
      return message

    } catch (error) {
      debug.error('MessageService: Failed to send channel message:', error)
      throw error
    }
  }

  /**
   * @param options.isSystem - stores as a system message; not federated.
   * @param options.allowPlaintextFallback - user-confirmed opt-in to send
   *   plaintext into a conversation marked encrypted when encryption is
   *   unavailable. Default is fail-closed.
   */
  async sendDMMessage(
    conversationId: string,
    content: MessagePart[],
    replyTo?: string,
    options?: { isSystem?: boolean; allowPlaintextFallback?: boolean },
    extraMetadata?: Record<string, any>
  ): Promise<Message> {
    try {
      debug.log(`MessageService: Sending DM message to conversation: ${conversationId}`)

      const message = await coreMessageService.sendDMMessage(conversationId, content, replyTo, options, extraMetadata)

      return message

    } catch (error) {
      debug.error('MessageService: Failed to send DM message:', error)
      throw error
    }
  }

  async editMessage(messageId: string, newContent: MessagePart[]): Promise<Message> {
    try {
      debug.log(`MessageService: Editing message: ${messageId}`)

      // Database triggers handle federation.
      const message = await coreMessageService.editMessage(messageId, newContent)

      return message

    } catch (error) {
      debug.error('MessageService: Failed to edit message:', error)
      throw error
    }
  }

  async deleteMessage(messageId: string): Promise<void> {
    try {
      debug.log(`MessageService: Deleting message: ${messageId}`)

      await coreMessageService.deleteMessage(messageId)

    } catch (error) {
      debug.error('MessageService: Failed to delete message:', error)
      throw error
    }
  }

  /**
   * Channel reactions stay local; DM reactions may federate.
   */
  async toggleReaction(
    messageId: string,
    emojiId: string
  ): Promise<{ added: boolean }> {
    try {
      debug.log(`MessageService: Toggling reaction for message: ${messageId}, emoji: ${emojiId}`)

      // No follow-up COUNT query: the reactions store updates counts
      // optimistically and reconciles against the per-message reconcile fetch
      // plus realtime.
      const result = await coreMessageService.toggleReaction(messageId, emojiId)

      return { added: result.added }

    } catch (error) {
      debug.error('MessageService: Failed to toggle message reaction:', error)
      throw error
    }
  }

  async getMessageReactions(messageId: string): Promise<Array<{
    emoji_id: string;
    emoji_name: string;
    count: number;
    users: Array<{ id: string; username: string; display_name?: string }>;
  }>> {
    try {
      debug.log(`MessageService: Loading reactions for message: ${messageId}`)

      const reactions = await coreMessageService.getMessageReactions(messageId)

      debug.log(`MessageService: Loaded ${reactions.length} reaction groups`)
      return reactions

    } catch (error) {
      debug.error('MessageService: Failed to load message reactions:', error)
      throw error
    }
  }

  async getBatchMessageReactions(messageIds: string[]): Promise<{
    [messageId: string]: Array<{
      emoji_id: string;
      emoji_name: string;
      count: number;
      users: Array<{ id: string; username: string; display_name?: string }>;
    }>;
  }> {
    try {
      debug.log(`MessageService: Loading reactions for ${messageIds.length} messages`)

      const reactions = await coreMessageService.getBatchMessageReactions(messageIds)

      debug.log(`MessageService: Loaded batch reactions successfully`)
      return reactions

    } catch (error) {
      debug.error('MessageService: Failed to load batch message reactions:', error)
      throw error
    }
  }

  async loadChannelMessages(
    channelId: string,
    options: {
      limit?: number;
      before?: string;
      after?: string;
      signal?: AbortSignal;
      /** Skip the remote-channel DB lookups when the caller already knows. */
      isRemote?: boolean;
    } = {}
  ): Promise<{
    messages: Message[];
    hasMore: boolean;
    nextCursor?: string;
  }> {
    try {
      debug.log(`MessageService: Loading channel messages for: ${channelId}`)

      const messages = await coreMessageService.loadChannelMessages(channelId, options)

      const { limit = 50 } = options
      const hasMore = messages.length === limit
      const lastCreated = hasMore ? messages[messages.length - 1]?.created_at : undefined
      const nextCursor = lastCreated ? (typeof lastCreated === 'string' ? lastCreated : (lastCreated as Date).toISOString()) : undefined
      
      const result = {
        messages,
        hasMore,
        nextCursor
      }

      debug.log(`MessageService: Loaded ${messages.length} channel messages`)
      return result

    } catch (error) {
      debug.error('MessageService: Failed to load channel messages:', error)
      throw error
    }
  }

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
      debug.log(`MessageService: Loading conversation messages for: ${conversationId}`)

      const messages = await coreMessageService.loadConversationMessages(conversationId, options)

      const { limit = 50 } = options
      const hasMore = messages.length === limit
      const lastCreated = hasMore ? messages[messages.length - 1]?.created_at : undefined
      const nextCursor = lastCreated ? (typeof lastCreated === 'string' ? lastCreated : (lastCreated as Date).toISOString()) : undefined
      
      const result = {
        messages,
        hasMore,
        nextCursor
      }

      debug.log(`MessageService: Loaded ${messages.length} conversation messages`)
      return result

    } catch (error) {
      debug.error('MessageService: Failed to load conversation messages:', error)
      throw error
    }
  }

  async loadMessage(messageId: string): Promise<Message | null> {
    try {
      debug.log(`MessageService: Loading message: ${messageId}`)

      const message = await coreMessageService.loadMessage(messageId)

      if (message) {
        debug.log(`MessageService: Message loaded successfully: ${messageId}`)
      } else {
        debug.log(`ℹMessageService: Message not found: ${messageId}`)
      }

      return message

    } catch (error) {
      debug.error('MessageService: Failed to load message:', error)
      throw error
    }
  }

  // MESSAGE PINNING

  async pinMessage(messageId: string): Promise<boolean> {
    try {
      debug.log(`Pinning message: ${messageId}`)

      const { error } = await supabase.rpc('pin_message', {
        p_message_id: messageId,
      })

      if (error) {
        debug.error('Failed to pin message:', error)
        throw this.createError('PIN_FAILED', error.message)
      }

      debug.log(`Message pinned successfully: ${messageId}`)
      return true
    } catch (error) {
      debug.error('Failed to pin message:', error)
      throw error
    }
  }

  async unpinMessage(messageId: string): Promise<boolean> {
    try {
      debug.log(`Unpinning message: ${messageId}`)

      const { error } = await supabase.rpc('unpin_message', {
        p_message_id: messageId,
      })

      if (error) {
        debug.error('Failed to unpin message:', error)
        throw this.createError('UNPIN_FAILED', error.message)
      }

      debug.log(`Message unpinned successfully: ${messageId}`)
      return true
    } catch (error) {
      debug.error('Failed to unpin message:', error)
      throw error
    }
  }

  async getPinnedChannelMessages(channelId: string): Promise<Message[]> {
    try {
      debug.log(`Loading pinned messages for channel: ${channelId}`)

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

      // Author fields are resolved by the component via useUserData.
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

      debug.log(`Loaded ${messages.length} pinned messages`)
      return messages
    } catch (error) {
      debug.error('Failed to load pinned messages:', error)
      throw error
    }
  }

  async getPinnedDMMessages(conversationId: string): Promise<Message[]> {
    try {
      debug.log(`Loading pinned messages for DM: ${conversationId}`)

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

      // Author fields are resolved by the component via useUserData.
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

      debug.log(`Loaded ${messages.length} pinned DM messages`)
      return messages
    } catch (error) {
      debug.error('Failed to load pinned DM messages:', error)
      throw error
    }
  }

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

export const messageService = MessageService.getInstance()