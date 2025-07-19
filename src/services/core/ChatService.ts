/**
 * ChatService - Clean interface for all message operations
 * 
 * Handles both Discord-like channel messages and DMs.
 * Automatically determines federation needs based on recipients.
 * Local-first design with optional federation.
 * 
 * Features:
 * - Unified message handling (channels and DMs)
 * - Auto-detection of federation needs
 * - Local-first operations  
 * - Clean error handling
 * - Federation status feedback
 */

import { supabase } from '@/supabase'
import { createOutgoingHandler } from '@/services/federation/OutgoingHandler'
import type { Message, MessagePart } from '@/types'

export interface SendMessageOptions {
  content: string | MessagePart[]
  replyTo?: string
  channelId?: string // For channel messages
  conversationId?: string // For DMs
  recipientId?: string // For creating new DM conversations
}

export interface MessageResult {
  success: boolean
  message?: Message
  error?: string
  federationStatus?: {
    attempted: boolean
    success: boolean
    targets?: string[]
    error?: string
  }
}

export interface MessageOperationResult {
  success: boolean
  error?: string
  localSuccess: boolean
  federationStatus?: {
    attempted: boolean
    success: boolean
    error?: string
  }
}

export class ChatService {
  private static instance: ChatService
  
  static getInstance(): ChatService {
    if (!ChatService.instance) {
      ChatService.instance = new ChatService()
    }
    return ChatService.instance
  }
  
  /**
   * Send a message (auto-detects channel vs DM)
   * Local-first: Sends locally, then federates if needed
   */
  async sendMessage(userId: string, options: SendMessageOptions): Promise<MessageResult> {
    console.log('💬 ChatService: Sending message for user:', userId)
    
    try {
      // Step 1: Validate and process content
      const processedContent = await this.processContent(options.content)
      
      // Step 2: Determine message type and validate
      const messageType = this.determineMessageType(options)
      
      if (messageType === 'invalid') {
        return {
          success: false,
          error: 'Invalid message configuration - must specify either channelId or conversationId/recipientId',
          federationStatus: { attempted: false, success: false }
        }
      }
      
      // Step 3: Send locally first
      const localResult = await this.sendLocalMessage(userId, {
        ...options,
        content: processedContent
      }, messageType)
      
      if (!localResult.success) {
        return {
          success: false,
          error: localResult.error,
          federationStatus: { attempted: false, success: false }
        }
      }
      
      console.log('✅ Message sent locally:', localResult.message?.id)
      
      // Step 4: Attempt federation if needed (optional, non-blocking)
      const federationStatus = await this.attemptFederation(localResult.message!, messageType)
      
      return {
        success: true,
        message: localResult.message,
        federationStatus
      }
      
    } catch (error) {
      console.error('❌ ChatService: Error sending message:', error)
      return {
        success: false,
        error: error.message,
        federationStatus: { attempted: false, success: false }
      }
    }
  }
  
  /**
   * Edit a message
   */
  async editMessage(messageId: string, userId: string, newContent: string | MessagePart[]): Promise<MessageOperationResult> {
    console.log('✏️ ChatService: Editing message:', messageId)
    
    try {
      // Verify ownership and get message details
      const { data: message, error: fetchError } = await supabase
        .from('messages')
        .select('user_id, channel_id, conversation_id')
        .eq('id', messageId)
        .single()
      
      if (fetchError || !message) {
        return {
          success: false,
          localSuccess: false,
          error: 'Message not found',
          federationStatus: { attempted: false, success: false }
        }
      }
      
      if (message.user_id !== userId) {
        return {
          success: false,
          localSuccess: false,
          error: 'Not authorized to edit this message',
          federationStatus: { attempted: false, success: false }
        }
      }
      
      // Process content
      const processedContent = await this.processContent(newContent)
      
      // Update locally
      const { error: updateError } = await supabase
        .from('messages')
        .update({ content: processedContent })
        .eq('id', messageId)
        .eq('user_id', userId)
      
      if (updateError) {
        throw updateError
      }
      
      console.log('✅ Message edited locally')
      
      // TODO: Implement federation for message edits (Update activity)
      const federationStatus = { attempted: false, success: false }
      
      return {
        success: true,
        localSuccess: true,
        federationStatus
      }
      
    } catch (error) {
      console.error('❌ ChatService: Error editing message:', error)
      return {
        success: false,
        localSuccess: false,
        error: error.message,
        federationStatus: { attempted: false, success: false }
      }
    }
  }
  
  /**
   * Delete a message
   */
  async deleteMessage(messageId: string, userId: string): Promise<MessageOperationResult> {
    console.log('🗑️ ChatService: Deleting message:', messageId)
    
    try {
      // Verify ownership
      const { data: message, error: fetchError } = await supabase
        .from('messages')
        .select('user_id')
        .eq('id', messageId)
        .single()
      
      if (fetchError || !message) {
        return {
          success: false,
          localSuccess: false,
          error: 'Message not found',
          federationStatus: { attempted: false, success: false }
        }
      }
      
      if (message.user_id !== userId) {
        return {
          success: false,
          localSuccess: false,
          error: 'Not authorized to delete this message',
          federationStatus: { attempted: false, success: false }
        }
      }
      
      // Delete locally
      const { error: deleteError } = await supabase
        .from('messages')
        .delete()
        .eq('id', messageId)
        .eq('user_id', userId)
      
      if (deleteError) {
        throw deleteError
      }
      
      console.log('✅ Message deleted locally')
      
      // TODO: Implement federation for message deletion (Delete activity)
      const federationStatus = { attempted: false, success: false }
      
      return {
        success: true,
        localSuccess: true,
        federationStatus
      }
      
    } catch (error) {
      console.error('❌ ChatService: Error deleting message:', error)
      return {
        success: false,
        localSuccess: false,
        error: error.message,
        federationStatus: { attempted: false, success: false }
      }
    }
  }
  
  /**
   * Get a message by ID
   */
  async getMessage(messageId: string): Promise<{ success: boolean; message?: Message; error?: string }> {
    try {
      const { data: message, error } = await supabase
        .from('messages')
        .select('*')
        .eq('id', messageId)
        .single()
      
      if (error) {
        return { success: false, error: error.message }
      }
      
      if (!message) {
        return { success: false, error: 'Message not found' }
      }
      
      return { success: true, message }
      
    } catch (error) {
      console.error('❌ ChatService: Error fetching message:', error)
      return { success: false, error: error.message }
    }
  }
  
  /**
   * Create or get DM conversation
   */
  async createOrGetConversation(userId: string, recipientId: string): Promise<{
    success: boolean
    conversationId?: string
    error?: string
  }> {
    try {
      // Check if conversation already exists
      const { data: existingConversation } = await supabase
        .from('conversations')
        .select('id')
        .or(`and(user1.eq.${userId},user2.eq.${recipientId}),and(user1.eq.${recipientId},user2.eq.${userId})`)
        .maybeSingle()
      
      if (existingConversation) {
        return { success: true, conversationId: existingConversation.id }
      }
      
      // Create new conversation
      const { data: newConversation, error } = await supabase
        .from('conversations')
        .insert([{
          user1: userId,
          user2: recipientId
        }])
        .select('id')
        .single()
      
      if (error) {
        return { success: false, error: error.message }
      }
      
      return { success: true, conversationId: newConversation.id }
      
    } catch (error) {
      console.error('❌ ChatService: Error creating conversation:', error)
      return { success: false, error: error.message }
    }
  }
  
  // =============================================
  // PRIVATE METHODS
  // =============================================
  
  /**
   * Process content into unified MessagePart[] format
   */
  private async processContent(content: string | MessagePart[]): Promise<MessagePart[]> {
    if (Array.isArray(content)) {
      return content // Already in correct format
    }
    
    // Convert string to MessagePart[] using existing utility
    const { parseContentToMessageParts, resolveMentionsUserData, resolveEmojisData, resolveHashtagsData } = 
      await import('@/utils/unifiedContentProcessing')
    
    const [usernameToUserDataMap, emojiDataMap, hashtagDataMap] = await Promise.all([
      resolveMentionsUserData(content),
      resolveEmojisData(content),
      resolveHashtagsData(content)
    ])
    
    return parseContentToMessageParts(content, usernameToUserDataMap, emojiDataMap, hashtagDataMap)
  }
  
  /**
   * Determine message type from options
   */
  private determineMessageType(options: SendMessageOptions): 'channel' | 'dm' | 'invalid' {
    if (options.channelId) {
      return 'channel'
    }
    
    if (options.conversationId || options.recipientId) {
      return 'dm'
    }
    
    return 'invalid'
  }
  
  /**
   * Send message locally based on type
   */
  private async sendLocalMessage(
    userId: string, 
    options: SendMessageOptions & { content: MessagePart[] },
    messageType: 'channel' | 'dm'
  ): Promise<{ success: boolean; message?: Message; error?: string }> {
    
    if (messageType === 'channel') {
      return this.sendChannelMessage(userId, options)
    } else {
      return this.sendDMMessage(userId, options)
    }
  }
  
  /**
   * Send channel message
   */
  private async sendChannelMessage(
    userId: string,
    options: SendMessageOptions & { content: MessagePart[] }
  ): Promise<{ success: boolean; message?: Message; error?: string }> {
    
    const { data: message, error } = await supabase
      .from('messages')
      .insert([{
        user_id: userId,
        channel_id: options.channelId,
        content: options.content,
        reply_to: options.replyTo
      }])
      .select('*')
      .single()
    
    if (error) {
      console.error('Failed to send channel message:', error)
      return { success: false, error: error.message }
    }
    
    return { success: true, message }
  }
  
  /**
   * Send DM message
   */
  private async sendDMMessage(
    userId: string,
    options: SendMessageOptions & { content: MessagePart[] }
  ): Promise<{ success: boolean; message?: Message; error?: string }> {
    
    let conversationId = options.conversationId
    
    // Create conversation if needed
    if (!conversationId && options.recipientId) {
      const conversationResult = await this.createOrGetConversation(userId, options.recipientId)
      if (!conversationResult.success) {
        return { success: false, error: conversationResult.error }
      }
      conversationId = conversationResult.conversationId
    }
    
    if (!conversationId) {
      return { success: false, error: 'No conversation ID available' }
    }
    
    const { data: message, error } = await supabase
      .from('messages')
      .insert([{
        user_id: userId,
        conversation_id: conversationId,
        content: options.content,
        reply_to: options.replyTo
      }])
      .select('*')
      .single()
    
    if (error) {
      console.error('Failed to send DM:', error)
      return { success: false, error: error.message }
    }
    
    return { success: true, message }
  }
  
  /**
   * Attempt federation based on message type and recipients
   */
  private async attemptFederation(
    message: Message, 
    messageType: 'channel' | 'dm'
  ): Promise<{
    attempted: boolean
    success: boolean
    targets?: string[]
    error?: string
  }> {
    
    if (messageType === 'channel') {
      // Channel messages typically don't federate in Discord-like systems
      // But could federate if there are remote users in the channel
      return { attempted: false, success: false }
    }
    
    if (messageType === 'dm') {
      return this.attemptDMFederation(message)
    }
    
    return { attempted: false, success: false }
  }
  
  /**
   * Attempt federation for DM
   */
  private async attemptDMFederation(message: Message): Promise<{
    attempted: boolean
    success: boolean
    targets?: string[]
    error?: string
  }> {
    try {
      if (!message.conversation_id) {
        return { attempted: false, success: false }
      }
      
      // Get conversation participants
      const { data: conversation, error: convError } = await supabase
        .from('conversations')
        .select('user1, user2')
        .eq('id', message.conversation_id)
        .single()
      
      if (convError || !conversation) {
        return { attempted: false, success: false, error: 'Conversation not found' }
      }
      
      // Determine recipient (the other user in conversation)
      const recipientId = conversation.user1 === message.user_id 
        ? conversation.user2 
        : conversation.user1
      
      // Check if recipient is remote
      const { data: recipient, error: recipientError } = await supabase
        .from('profiles')
        .select('is_local, domain')
        .eq('id', recipientId)
        .single()
      
      if (recipientError || !recipient) {
        return { attempted: false, success: false, error: 'Recipient not found' }
      }
      
      if (recipient.is_local) {
        console.log('📍 DM recipient is local, no federation needed')
        return { attempted: false, success: true }
      }
      
      // Federate to remote recipient
      const outgoingHandler = await createOutgoingHandler()
      
      const result = await outgoingHandler.federateDM({
        id: message.id,
        content: message.content,
        user_id: message.user_id,
        conversation_id: message.conversation_id,
        recipient_id: recipientId
      })
      
      return {
        attempted: true,
        success: result.success,
        targets: result.targets,
        error: result.error
      }
      
    } catch (error) {
      console.error('❌ DM federation failed:', error)
      return {
        attempted: true,
        success: false,
        error: error.message
      }
    }
  }
}

// Export singleton instance
export const chatService = ChatService.getInstance()