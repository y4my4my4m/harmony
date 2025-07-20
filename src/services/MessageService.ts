/**
 * MessageService - Orchestrated message management
 * 
 * ORCHESTRATION PATTERN: Combines Core + Federation services
 * - CoreMessageService: Pure local database operations
 * - FederationDecisionService: Federation decision logic
 * - FederationActivityService: ActivityPub activity creation
 * 
 * PRESERVED APIs: 
 * - ✅ Same method signatures as before
 * - ✅ Same return types and error formats
 * - ✅ Same loading patterns and race condition handling
 * - ✅ Same local-first design (immediate UI updates)
 * 
 * ENHANCED ARCHITECTURE:
 * - Clean separation of concerns
 * - Testable service components
 * - Professional orchestration patterns
 */

import { supabase } from '@/supabase'
import type { Message, MessagePart, ReactionGroup } from '@/types'

// Import core and federation services
import { coreMessageService } from './core'
import { federationDecisionService, federationActivityService } from './federation'

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
  // MESSAGE SENDING (ORCHESTRATED: CORE + FEDERATION)
  // =====================================================

  /**
   * Send a server channel message (orchestrated: local-first, no federation)
   */
  async sendChannelMessage(
    serverId: string,
    channelId: string,
    content: MessagePart[],
    replyTo?: string
  ): Promise<Message> {
    try {
      console.log(`🎭 Orchestration: Sending channel message to channel: ${channelId}`)

      // 1. Core operation: Pure local message creation
      const message = await coreMessageService.sendChannelMessage(serverId, channelId, content, replyTo)

      // 2. Federation decision: Server messages don't federate (local-first design)
      console.log(`ℹ️ Orchestration: Channel messages stay local (no federation needed)`)

      console.log(`✅ Orchestration: Channel message sent successfully: ${message.id}`)
      return message

    } catch (error) {
      console.error('❌ Orchestration: Failed to send channel message:', error)
      throw error
    }
  }

  /**
   * Send a DM message (orchestrated: local-first + conditional federation)
   */
  async sendDMMessage(
    conversationId: string,
    content: MessagePart[],
    replyTo?: string
  ): Promise<Message> {
    try {
      console.log(`🎭 Orchestration: Sending DM message to conversation: ${conversationId}`)

      // 1. Core operation: Pure local message creation (always first)
      const message = await coreMessageService.sendDMMessage(conversationId, content, replyTo)

      // 2. Federation decision: Should this DM federate?
      const decision = await federationDecisionService.shouldFederateMessage(message.id, 'create')
      
      if (decision.shouldFederate) {
        console.log(`📤 Orchestration: DM eligible for federation: ${decision.reason}`)
        
        // 3. Federation operation: Create ActivityPub activity
        const activityResult = await federationActivityService.createMessageActivity(message.id, 'create')
        
        if (activityResult.success) {
          console.log(`✅ Orchestration: DM federation activity created: ${activityResult.activityId}`)
        } else {
          console.warn(`⚠️ Orchestration: DM federation failed (message still sent locally): ${activityResult.error}`)
        }
      } else {
        console.log(`ℹ️ Orchestration: DM federation skipped: ${decision.reason}`)
      }

      console.log(`✅ Orchestration: DM message sent successfully: ${message.id}`)
      return message

    } catch (error) {
      console.error('❌ Orchestration: Failed to send DM message:', error)
      throw error
    }
  }

  /**
   * Edit a message (orchestrated: local-first + conditional federation)
   */
  async editMessage(messageId: string, newContent: MessagePart[]): Promise<Message> {
    try {
      console.log(`🎭 Orchestration: Editing message: ${messageId}`)

      // 1. Core operation: Pure local message update
      const message = await coreMessageService.editMessage(messageId, newContent)

      // 2. Federation decision: Should this edit federate?
      const decision = await federationDecisionService.shouldFederateMessage(messageId, 'update')
      
      if (decision.shouldFederate) {
        console.log(`📤 Orchestration: Message edit eligible for federation: ${decision.reason}`)
        
        // 3. Federation operation: Create ActivityPub Update activity
        const activityResult = await federationActivityService.createMessageActivity(messageId, 'update')
        
        if (activityResult.success) {
          console.log(`✅ Orchestration: Message edit federation activity created: ${activityResult.activityId}`)
        } else {
          console.warn(`⚠️ Orchestration: Message edit federation failed (edit still applied locally): ${activityResult.error}`)
        }
      } else {
        console.log(`ℹ️ Orchestration: Message edit federation skipped: ${decision.reason}`)
      }

      console.log(`✅ Orchestration: Message edited successfully: ${messageId}`)
      return message

    } catch (error) {
      console.error('❌ Orchestration: Failed to edit message:', error)
      throw error
    }
  }

  /**
   * Delete a message (orchestrated: local-first + conditional federation)
   */
  async deleteMessage(messageId: string): Promise<void> {
    try {
      console.log(`🎭 Orchestration: Deleting message: ${messageId}`)

      // Check federation before deletion (need message data)
      const decision = await federationDecisionService.shouldFederateMessage(messageId, 'delete')

      // 1. Core operation: Pure local message deletion
      await coreMessageService.deleteMessage(messageId)

      // 2. Federation operation: Create Delete activity if needed
      if (decision.shouldFederate) {
        console.log(`📤 Orchestration: Message deletion eligible for federation: ${decision.reason}`)
        
        const activityResult = await federationActivityService.createMessageActivity(messageId, 'delete')
        
        if (activityResult.success) {
          console.log(`✅ Orchestration: Message deletion federation activity created: ${activityResult.activityId}`)
        } else {
          console.warn(`⚠️ Orchestration: Message deletion federation failed (message still deleted locally): ${activityResult.error}`)
        }
      } else {
        console.log(`ℹ️ Orchestration: Message deletion federation skipped: ${decision.reason}`)
      }

      console.log(`✅ Orchestration: Message deleted successfully: ${messageId}`)

    } catch (error) {
      console.error('❌ Orchestration: Failed to delete message:', error)
      throw error
    }
  }

  // =====================================================
  // REACTIONS (ORCHESTRATED: CORE + FEDERATION)
  // =====================================================

  /**
   * Toggle reaction (orchestrated: local-first + conditional federation)
   * PRESERVES: Exact same API, return type, and race condition handling
   */
  async toggleReaction(
    messageId: string, 
    emojiId: string, 
    options: {
      signal?: AbortSignal;
    } = {}
  ): Promise<{ added: boolean; hadRaceCondition?: boolean }> {
    try {
      console.log(`🎭 Orchestration: Toggling reaction: message=${messageId}, emoji=${emojiId}`)

      // 1. Core operation: Pure local reaction toggle (with race condition handling)
      const result = await coreMessageService.toggleReaction(messageId, emojiId)

      // 2. Get current user for federation decision
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      // 3. Federation decision: Should this reaction federate? (implements local-first)
      const decision = await federationDecisionService.shouldFederateReaction(messageId, profileId)
      
      if (decision.shouldFederate) {
        console.log(`📤 Orchestration: Reaction eligible for federation: ${decision.reason}`)
        
        // 4. Federation operation: Create reaction activity
        const operation = result.added ? 'add' : 'remove'
        const activityResult = await federationActivityService.createMessageReactionActivity(
          messageId, 
          emojiId, 
          profileId, 
          operation
        )
        
        if (activityResult.success) {
          console.log(`✅ Orchestration: Reaction federation activity created: ${activityResult.activityId}`)
        } else {
          console.warn(`⚠️ Orchestration: Reaction federation failed (reaction still applied locally): ${activityResult.error}`)
        }
      } else {
        console.log(`ℹ️ Orchestration: Reaction federation skipped: ${decision.reason}`)
      }

      console.log(`✅ Orchestration: Reaction toggled successfully: ${result.added ? 'added' : 'removed'}`)
      return result

    } catch (error) {
      console.error('❌ Orchestration: Failed to toggle reaction:', error)
      throw error
    }
  }

  /**
   * Get message reactions (delegated to core service)
   * PRESERVES: Exact same API and return type
   */
  async getMessageReactions(
    messageId: string, 
    options: {
      signal?: AbortSignal;
    } = {}
  ): Promise<any[]> {
    try {
      console.log(`🎭 Orchestration: Getting reactions for message: ${messageId}`)
      
      // Delegate to core service (no federation needed for reads)
      const reactions = await coreMessageService.getMessageReactions(messageId)
      
      console.log(`✅ Orchestration: Retrieved ${reactions.length} reactions`)
      return reactions

    } catch (error) {
      console.error('❌ Orchestration: Failed to get message reactions:', error)
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
      console.log(`🎭 Orchestration: Loading channel messages: ${channelId}`)
      
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
      
      console.log(`✅ Orchestration: Loaded ${messages.length} channel messages`)
      return result

    } catch (error) {
      console.error('❌ Orchestration: Failed to load channel messages:', error)
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
      console.log(`🎭 Orchestration: Loading conversation messages: ${conversationId}`)
      
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
      
      console.log(`✅ Orchestration: Loaded ${messages.length} conversation messages`)
      return result

    } catch (error) {
      console.error('❌ Orchestration: Failed to load conversation messages:', error)
      throw error
    }
  }

  /**
   * Load single message (delegated to core service)
   * PRESERVES: Exact same API and return type
   */
  async loadMessage(messageId: string): Promise<Message | null> {
    try {
      console.log(`🎭 Orchestration: Loading message: ${messageId}`)
      
      // Delegate to core service (no federation needed for reads)
      const message = await coreMessageService.loadMessage(messageId)
      
      if (message) {
        console.log(`✅ Orchestration: Message loaded successfully: ${messageId}`)
      } else {
        console.log(`ℹ️ Orchestration: Message not found: ${messageId}`)
      }
      
      return message

    } catch (error) {
      console.error('❌ Orchestration: Failed to load message:', error)
      throw error
    }
  }

  // =====================================================
  // HELPER METHODS (PRESERVED)
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
      console.error('❌ Orchestration: Failed to get current user profile ID:', error)
      throw error
    }
  }

  private createError(code: string, message: string, details?: any): MessageServiceError {
    const secureDetails = process.env.NODE_ENV === 'development' ? details : undefined
    return { code, message, details: secureDetails }
  }
}

// Export singleton instance
export const messageService = MessageService.getInstance()