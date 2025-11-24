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
import { userDataService } from '@/services/userDataService'

// Lazy load encryption service to avoid loading native modules in browser
let messageEncryptionService: any = null
async function getEncryptionService() {
  if (!messageEncryptionService) {
    try {
      const module = await import('@/services/encryption/MessageEncryptionService')
      messageEncryptionService = module.messageEncryptionService
    } catch (error) {
      console.warn('⚠️ Encryption service not available:', error)
      messageEncryptionService = null
    }
  }
  return messageEncryptionService
}

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
      // Get current user from cached userDataService (no database calls)
      const currentUser = userDataService.getCurrentUser()
      if (!currentUser?.id) {
        throw this.createError('AUTH_REQUIRED', 'User not authenticated')
      }

      // Check if sender has encryption enabled
      let finalContent = content
      let encrypted = false
      let encryptionMetadata = null

      const encryptionService = await getEncryptionService()
      if (encryptionService && encryptionService.isInitialized()) {
        try {
          // If the sender has encryption keys, encrypt the message
          const hasKeys = await encryptionService.hasEncryptionKeys()
          
          if (hasKeys) {
            console.log('🔐 Sender has encryption - encrypting message')
            
            // Get all server members
            const { data: members } = await supabase
              .from('user_servers')
              .select('user_id')
              .eq('server_id', serverId)
            
            const allUserIds = members?.map(m => m.user_id).filter(id => id !== currentUser.id) || []
            
            // Filter to only users with encryption keys (who can decrypt)
            const { data: usersWithKeys } = await supabase
              .from('user_key_pairs')
              .select('user_id')
              .in('user_id', allUserIds)
              .eq('is_active', true)
            
            const recipientIds = usersWithKeys?.map(u => u.user_id) || []
            
            // IMPORTANT: Always include yourself so you can decrypt your own messages!
            if (!recipientIds.includes(currentUser.id)) {
              recipientIds.push(currentUser.id)
            }
            
            console.log(`🔐 Encrypting for ${recipientIds.length} recipients (including self)`)
            
            // Encrypt message for users who can decrypt (including yourself)
            const encryptedData = await encryptionService.encryptMessage(content, recipientIds)
            finalContent = encryptedData.content
            encrypted = true
            encryptionMetadata = encryptedData.encryption_metadata
            console.log(`✅ Message encrypted successfully`)
          } else {
            console.log('ℹ️ Sender does not have encryption - sending plaintext')
          }
        } catch (error) {
          console.error('❌ Encryption failed:', error)
          // If encryption fails, check if server requires it
          const policy = await encryptionService.checkServerEncryptionPolicy(serverId)
          if (policy.mode === 'required' || policy.mode === 'required_local_only') {
            throw error
          }
          // Otherwise, send unencrypted
          console.warn('⚠️ Falling back to unencrypted message')
        }
      }

      const messageData = {
        user_id: currentUser.id,
        channel_id: channelId,
        content: finalContent,
        reply_to: replyTo || null,
        encrypted,
        encryption_metadata: encryptionMetadata,
        metadata: { created_via: 'harmony_client' }
      }

      console.log('📤 Inserting message to database:', { ...messageData, content: encrypted ? '[encrypted]' : messageData.content })
      
      const { data: message, error } = await supabase
        .from('messages')
        .insert(messageData)
        .select('*')
        .single()

      if (error) {
        console.error('❌ DATABASE INSERT FAILED:', error)
        throw this.createError('INSERT_FAILED', error.message, error)
      }
      
      if (!message) {
        console.error('❌ No message returned from insert!')
        throw this.createError('INSERT_FAILED', 'No message returned from database')
      }

      console.log('✅ Message inserted to database successfully:', message.id)
      console.log('📦 Returned message:', message)
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
      // Get current user from cached userDataService (no database calls)
      const currentUser = userDataService.getCurrentUser()
      if (!currentUser?.id) {
        throw this.createError('AUTH_REQUIRED', 'User not authenticated')
      }

      // Check encryption for conversation
      let finalContent = content
      let encrypted = false
      let encryptionMetadata = null

      const encryptionService = await getEncryptionService()
      if (encryptionService && encryptionService.isInitialized()) {
        try {
          const status = await encryptionService.checkConversationEncryption(conversationId)
          
          // Auto-enable encryption if both parties have keys and it's not already enabled
          if (!status.enabled && status.hasKeys) {
            // Check if all participants have encryption keys
            const allHaveKeys = status.mode === 'optional' // This means everyone has keys
            
            if (allHaveKeys) {
              console.log('🔐 Auto-enabling encryption for conversation...')
              try {
                await encryptionService.enableConversationEncryption(conversationId)
                // Re-check status after enabling
                const newStatus = await encryptionService.checkConversationEncryption(conversationId)
                if (newStatus.enabled) {
                  console.log('✅ Encryption auto-enabled for conversation')
                }
              } catch (error) {
                console.warn('⚠️ Could not auto-enable encryption:', error)
              }
            }
          }
          
          // Re-check if encryption is now enabled
          const finalStatus = await encryptionService.checkConversationEncryption(conversationId)
          
          if (finalStatus.enabled) {
            // Get conversation participants
            const { data: participants } = await supabase
              .from('conversation_participants')
              .select('user_id')
              .eq('conversation_id', conversationId)
              .is('left_at', null)
            
            const recipientIds = participants?.map(p => p.user_id).filter(id => id !== currentUser.id) || []
            
            if (recipientIds.length > 0) {
              // Encrypt message
              const encryptedData = await encryptionService.encryptMessage(content, recipientIds)
              finalContent = encryptedData.content
              encrypted = true
              encryptionMetadata = encryptedData.encryption_metadata
              console.log(`🔐 DM encrypted for ${recipientIds.length} recipients`)
            }
          }
        } catch (error) {
          console.error('❌ DM encryption failed:', error)
          // DMs are typically always encrypted if enabled, so throw error
          const status = await encryptionService.checkConversationEncryption(conversationId)
          if (status.enabled) {
            throw error
          }
        }
      }

      const messageData = {
        user_id: currentUser.id,
        conversation_id: conversationId,
        content: finalContent,
        reply_to: replyTo || null,
        encrypted,
        encryption_metadata: encryptionMetadata,
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
      const { data: message, error } = await supabase
        .from('messages')
        .update({ 
          content: newContent,
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
      const { error } = await supabase
        .from('messages')
        .update({ 
          content: [{ type: 'text', text: '[deleted]' }] as MessagePart[],
          is_deleted: true,
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

      // SIMPLIFIED: Only support NEW format (migration fixed the database)
      const transformedReactions = reactions?.map(reaction => ({
        emoji_id: reaction.emoji.id,
        emoji: {
          id: reaction.emoji.id,
          name: reaction.emoji.name,
          url: reaction.emoji.url
        },
        count: reaction.count,
        reactions: Array.isArray(reaction.reactions) ? reaction.reactions : [],
        message_id_of_reactions: reaction.message_id_of_reactions
      })) || []
      console.log(`✅ Core: Fetched ${transformedReactions.length} reaction groups for message: ${messageId}`)
      return transformedReactions
    } catch (error) {
      console.error('❌ Core: Error in getMessageReactions:', error)
      throw error
    }
  }

  /**
   * Get reactions for multiple messages using optimized database function (pure local)
   * PERFORMANCE: Uses database function to eliminate N+1 query problem
   */
  async getBatchMessageReactions(messageIds: string[]): Promise<Record<string, any[]>> {
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
            name: reaction.emoji_name || 'unknown',
            url: reaction.emoji_url || ''
          },
          count: reaction.reaction_count || 0,
          reactions: Array.isArray(reaction.users) ? reaction.users : []
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
  // REACTIONS STORE INTEGRATION
  // =====================================================

    /**
   * ✅ ARCHITECTURE FIX: Populate reactions store cache with batch-loaded data
   * This unifies CoreMessageService and ReactionsStore to work together
   */
  private async populateReactionsStoreCache(reactionsByMessage: Record<string, any[]>): Promise<void> {
    try {
      // Dynamically import to avoid circular dependencies
      const { useReactionsStore } = await import('@/stores/useReactions')
      const reactionsStore = useReactionsStore()
      
      // Use the store's bulk set method to populate cache
      reactionsStore.bulkSetReactions(reactionsByMessage)
      
      console.log(`✅ Core: Synced ${Object.keys(reactionsByMessage).length} message reactions to store cache`)
    } catch (error) {
      console.warn('⚠️ Core: Failed to sync reactions to store cache:', error)
      // Don't throw - this is not critical to core functionality
    }
  }

  // =====================================================
  // MESSAGE LOADING (PURE LOCAL)
  // =====================================================

  /**
   * Load channel messages with pagination (pure local)
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

      console.log(`🔄 Core: Loading messages for channel: ${channelId}`, { limit, before, after })

      let query = supabase
        .from('messages')
        .select('*')
        .eq('channel_id', channelId)
        .or('is_deleted.is.null,is_deleted.eq.false')
        .order('created_at', { ascending: false })  // Get NEWEST messages first
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

      console.log('📤 Executing message load query...')
      const { data: messages, error } = await query

      if (error) {
        console.error('❌ Failed to load messages:', error)
        throw this.createError('LOAD_MESSAGES_FAILED', error.message, error)
      }

      const messageList = messages || []
      console.log(`✅ Loaded ${messageList.length} messages from database for channel ${channelId}`)
      
      // Reverse to get oldest-first for display (since query returns newest-first)
      const orderedMessages = messageList.reverse()

      // PERFORMANCE OPTIMIZATION: Batch load reactions for all messages
      if (orderedMessages.length > 0) {
        const messageIds = orderedMessages.map(m => m.id)
        const reactionsByMessage = await this.getBatchMessageReactions(messageIds)
        
        // Attach reactions to each message
        orderedMessages.forEach(message => {
          message.reactions = reactionsByMessage[message.id] || []
        })
        
        // ✅ ARCHITECTURE FIX: Populate reactions store cache with batch-loaded data
        // This ensures components can use reactionsStore.getMessageReactions() seamlessly
        await this.populateReactionsStoreCache(reactionsByMessage)
      }

      console.log(`✅ Core: Loaded ${orderedMessages.length} messages with reactions for channel: ${channelId}`)
      
      // Process encrypted messages
      const { processMessageDecryption } = await import('@/utils/messageDecryption')
      const decryptedMessages = await processMessageDecryption(orderedMessages)
      
      return decryptedMessages
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
        .order('created_at', { ascending: false })  // Get NEWEST messages first (same as channels)
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
      
      // Reverse to get oldest-first for display (since query returns newest-first)
      const orderedMessages = messageList.reverse()

      // PERFORMANCE OPTIMIZATION: Batch load reactions for all messages
      if (orderedMessages.length > 0) {
        const messageIds = orderedMessages.map(m => m.id)
        const reactionsByMessage = await this.getBatchMessageReactions(messageIds)
        
        // Attach reactions to each message
        orderedMessages.forEach(message => {
          message.reactions = reactionsByMessage[message.id] || []
        })
        
        // ✅ ARCHITECTURE FIX: Populate reactions store cache with batch-loaded data
        // This ensures components can use reactionsStore.getMessageReactions() seamlessly  
        await this.populateReactionsStoreCache(reactionsByMessage)
      }

      console.log(`✅ Core: Loaded ${orderedMessages.length} messages with reactions for conversation: ${conversationId}`)
      
      // Process encrypted messages
      const { processMessageDecryption } = await import('@/utils/messageDecryption')
      const decryptedMessages = await processMessageDecryption(orderedMessages)
      
      return decryptedMessages
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

  /**
   * Get current user's profile ID
   * Used for reactions and other user-specific operations
   */
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