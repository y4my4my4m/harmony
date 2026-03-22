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
import { authContextService } from '@/services/AuthContextService'
import { debug } from '@/utils/debug'

// Lazy load and auto-initialize Megolm encryption service
let megolmEncryptionService: any = null
async function getEncryptionService() {
  if (!megolmEncryptionService) {
    try {
      const module = await import('@/services/encryption/MegolmMessageEncryptionService')
      megolmEncryptionService = module.megolmMessageEncryptionService
    } catch (error) {
      debug.warn('⚠️ Megolm encryption service not available:', error)
      megolmEncryptionService = null
    }
  }
  if (megolmEncryptionService && !megolmEncryptionService.isInitialized()) {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.user?.id) {
        debug.log('🔐 Lazy-initializing encryption service...')
        await megolmEncryptionService.initialize(session.user.id)
      }
    } catch (error) {
      debug.warn('⚠️ Failed to lazy-initialize encryption:', error)
    }
  }
  return megolmEncryptionService
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
   * Fetch max media attachments limit from instance config (default 20)
   */
  private async getMaxMediaAttachments(): Promise<number> {
    const { data } = await supabase
      .from('instance_config')
      .select('config_value')
      .eq('config_key', 'max_media_attachments_per_post')
      .maybeSingle()
    const v = data?.config_value
    if (typeof v === 'number' && v >= 1) return v
    const parsed = typeof v === 'string' ? parseInt(String(v), 10) : NaN
    return !isNaN(parsed) && parsed >= 1 ? parsed : 20
  }

  /**
   * Send a server channel message (pure local database operation)
   */
  async sendChannelMessage(
    serverId: string,
    channelId: string,
    content: MessagePart[],
    replyTo?: string,
    extraMetadata?: Record<string, any>
  ): Promise<Message> {
    try {
      // Enforce max media attachments per message (instance config, default 20)
      const fileParts = content.filter((p: any) => p?.type === 'file')
      const maxMedia = await this.getMaxMediaAttachments()
      if (fileParts.length > maxMedia) {
        throw this.createError('TOO_MANY_ATTACHMENTS', `Maximum ${maxMedia} media attachments per message`)
      }

      // Get current user from cached userDataService (no database calls)
      const currentUser = userDataService.getCurrentUser()
      if (!currentUser?.id) {
        throw this.createError('AUTH_REQUIRED', 'User not authenticated')
      }

      // Check server encryption settings first
      let finalContent = content
      let encrypted = false
      let encryptionMetadata = null

      // Get server encryption policy
      const { data: serverSettings } = await supabase
        .from('server_encryption_settings')
        .select('encryption_mode')
        .eq('server_id', serverId)
        .maybeSingle()
      
      const encryptionMode = serverSettings?.encryption_mode || 'optional'
      debug.log(`🔐 Server encryption mode: ${encryptionMode}`)

      // Skip encryption if server has it disabled
      if (encryptionMode === 'disabled') {
        debug.log('ℹ️ Server has encryption disabled - sending plaintext')
      } else {
        // Encryption is optional or required - check if user can encrypt
        const encryptionService = await getEncryptionService()
        
        if (encryptionService && encryptionService.isInitialized()) {
          const hasRecoveryKey = await encryptionService.hasRecoveryKey()
          const isUnlocked = encryptionService.isUnlocked()
          
          debug.log(`🔐 Encryption check: hasRecoveryKey=${hasRecoveryKey}, isUnlocked=${isUnlocked}`)
          
          if (hasRecoveryKey && isUnlocked) {
            try {
              debug.log('🔐 Megolm encryption active - encrypting message for channel')
              debug.log(`🔐 Channel (room): ${channelId}`)
              
              // Get all server members to share session key with
              const { data: members } = await supabase
                .from('user_servers')
                .select('user_id')
                .eq('server_id', serverId)
              
              const recipientIds = members?.map(m => m.user_id) || []
              if (!recipientIds.includes(currentUser.id)) {
                recipientIds.push(currentUser.id)
              }
              
              debug.log(`🔐 Encrypting for channel with ${recipientIds.length} members`)
              
              // Encrypt message with Megolm (channel-wide session key)
              const encryptedData = await encryptionService.encryptMessage(content, channelId, recipientIds)
              finalContent = encryptedData.content
              encrypted = true
              encryptionMetadata = encryptedData.encryption_metadata
              debug.log(`✅ Message encrypted with Megolm (session: ${encryptionMetadata.session_id?.substring(0, 8)}...)`)
            } catch (error) {
              debug.error('❌ Encryption failed:', error)
              if (encryptionMode === 'required') {
                throw this.createError('ENCRYPTION_REQUIRED', 'Server requires encryption but encryption failed')
              }
              debug.warn('⚠️ Falling back to unencrypted message')
            }
          } else if (encryptionMode === 'required') {
            // Server requires encryption but user doesn't have it set up/unlocked
            if (!hasRecoveryKey) {
              throw this.createError('ENCRYPTION_REQUIRED', 'This server requires encryption. Set up encryption in Settings first.')
            } else {
              throw this.createError('ENCRYPTION_LOCKED', 'This server requires encryption. Unlock encryption with your recovery key first.')
            }
          } else {
            // Optional encryption - user doesn't have it, send plaintext
            if (hasRecoveryKey && !isUnlocked) {
              debug.log('🔐 Encryption locked - enter recovery key to send encrypted messages')
            } else {
              debug.log('ℹ️ No encryption set up - sending plaintext')
            }
          }
        } else if (encryptionMode === 'required') {
          throw this.createError('ENCRYPTION_REQUIRED', 'This server requires encryption. Set up encryption in Settings first.')
        } else {
          debug.log('ℹ️ Encryption service not available - sending plaintext')
        }
      }

      const messageData = {
        user_id: currentUser.id,
        channel_id: channelId,
        content: finalContent,
        reply_to: replyTo || null,
        encrypted,
        encryption_metadata: encryptionMetadata,
        metadata: { created_via: 'harmony_client', ...extraMetadata }
      }

      debug.log('📤 Inserting message to database:', { ...messageData, content: encrypted ? '[encrypted]' : messageData.content })
      
      const { data: message, error } = await supabase
        .from('messages')
        .insert(messageData)
        .select('*')
        .single()

      if (error) {
        debug.error('❌ DATABASE INSERT FAILED:', error)
        throw this.createError('INSERT_FAILED', error.message, error)
      }
      
      if (!message) {
        debug.error('❌ No message returned from insert!')
        throw this.createError('INSERT_FAILED', 'No message returned from database')
      }

      debug.log('✅ Message inserted to database successfully:', message.id)
      debug.log('📦 Returned message:', message)
      return message
    } catch (error) {
      debug.error('❌ Failed to send channel message:', error)
      throw error
    }
  }

  /**
   * Send a DM message (pure local database operation)
   * Note: Federation handling is done by orchestrator service
   * @param options.isSystem - If true, stores as system message (no encryption, not federated)
   */
  async sendDMMessage(
    conversationId: string,
    content: MessagePart[],
    replyTo?: string,
    options?: { isSystem?: boolean },
    extraMetadata?: Record<string, any>
  ): Promise<Message> {
    try {
      // Enforce max media attachments per message (instance config, default 20)
      const isSystem = options?.isSystem ?? false
      if (!isSystem) {
        const fileParts = content.filter((p: any) => p?.type === 'file')
        const maxMedia = await this.getMaxMediaAttachments()
        if (fileParts.length > maxMedia) {
          throw this.createError('TOO_MANY_ATTACHMENTS', `Maximum ${maxMedia} media attachments per message`)
        }
      }

      // Get current user from cached userDataService (no database calls)
      const currentUser = userDataService.getCurrentUser()
      if (!currentUser?.id) {
        throw this.createError('AUTH_REQUIRED', 'User not authenticated')
      }

      // System messages: no encryption
      let finalContent = content
      let encrypted = false
      let encryptionMetadata = null

      if (isSystem) {
        const messageData = {
          user_id: currentUser.id,
          conversation_id: conversationId,
          content,
          reply_to: null,
          is_system: true,
          metadata: { created_via: 'harmony_client', type: 'group_created' }
        }
        const { data: message, error } = await supabase
          .from('messages')
          .insert(messageData)
          .select('*')
          .single()
        if (error) throw this.createError('INSERT_FAILED', error.message, error)
        debug.log('✅ System message sent successfully')
        return message
      }

      // Check if conversation has encryption enabled
      const { data: convSettings } = await supabase
        .from('conversation_encryption_settings')
        .select('encryption_enabled')
        .eq('conversation_id', conversationId)
        .maybeSingle()

      const conversationEncryptionEnabled = convSettings?.encryption_enabled === true
      debug.log(`🔐 Conversation encryption setting: ${conversationEncryptionEnabled ? 'enabled' : 'disabled'}`)

      const encryptionService = await getEncryptionService()
      if (conversationEncryptionEnabled && encryptionService && encryptionService.isInitialized()) {
        try {
          // Check if sender has recovery key set up and encryption unlocked
          const hasRecoveryKey = await encryptionService.hasRecoveryKey()
          const isUnlocked = encryptionService.isUnlocked()
          
          if (hasRecoveryKey && isUnlocked) {
            debug.log('🔐 Megolm encryption active - encrypting DM')
            debug.log(`🔐 Conversation (room): ${conversationId}`)
            
            // Get conversation participants
            const { data: participants } = await supabase
              .from('conversation_participants')
              .select('user_id')
              .eq('conversation_id', conversationId)
              .is('left_at', null)
            
            // Get participant IDs (session will be shared with all)
            const recipientIds = participants?.map(p => p.user_id) || []
            if (!recipientIds.includes(currentUser.id)) {
              recipientIds.push(currentUser.id)
            }
            
            debug.log(`🔐 Encrypting DM for ${recipientIds.length} participants`)
            
            // Encrypt message with Megolm (conversation-wide session key)
            const encryptedData = await encryptionService.encryptMessage(content, conversationId, recipientIds)
            finalContent = encryptedData.content
            encrypted = true
            encryptionMetadata = encryptedData.encryption_metadata
            debug.log(`✅ DM encrypted with Megolm (session: ${encryptionMetadata.session_id?.substring(0, 8)}...)`)
          } else if (hasRecoveryKey && !isUnlocked) {
            debug.log('🔐 Encryption locked - enter recovery key to send encrypted DMs')
          } else {
            debug.log('ℹ️ No encryption set up - sending plaintext DM')
          }
        } catch (error) {
          debug.error('❌ DM encryption failed:', error)
          // Warn user instead of silently falling back to plaintext
          console.warn('[Harmony] DM encryption failed — message will be sent unencrypted.', error)
          window.dispatchEvent(new CustomEvent('encryption-fallback', {
            detail: { type: 'dm', conversationId, error: String(error) }
          }))
        }
      }

      const messageData = {
        user_id: currentUser.id,
        conversation_id: conversationId,
        content: finalContent,
        reply_to: replyTo || null,
        encrypted,
        encryption_metadata: encryptionMetadata,
        metadata: { created_via: 'harmony_client', ...extraMetadata }
      }

      const { data: message, error } = await supabase
        .from('messages')
        .insert(messageData)
        .select('*')
        .single()

      if (error) throw this.createError('INSERT_FAILED', error.message, error)

      debug.log('✅ DM message sent successfully (local only)')
      return message
    } catch (error) {
      debug.error('❌ Failed to send DM message:', error)
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
      // Enforce max media attachments per message (instance config, default 20)
      const fileParts = newContent.filter((p: any) => p?.type === 'file')
      const maxMedia = await this.getMaxMediaAttachments()
      if (fileParts.length > maxMedia) {
        throw this.createError('TOO_MANY_ATTACHMENTS', `Maximum ${maxMedia} media attachments per message`)
      }

      // Get current user from cached userDataService (no database calls)
      const currentUser = userDataService.getCurrentUser()
      if (!currentUser?.id) {
        throw this.createError('AUTH_REQUIRED', 'User not authenticated')
      }

      // First, get the original message to check if it's encrypted
      const { data: originalMessage, error: fetchError } = await supabase
        .from('messages')
        .select('*')
        .eq('id', messageId)
        .single()

      if (fetchError) throw this.createError('FETCH_FAILED', fetchError.message, fetchError)
      if (!originalMessage) throw this.createError('NOT_FOUND', 'Message not found')

      let finalContent = newContent
      let encrypted = false
      let encryptionMetadata = null

      // If the original message was encrypted, re-encrypt the edited content
      if (originalMessage.encrypted && originalMessage.encryption_metadata) {
        debug.log('🔐 Original message was encrypted - re-encrypting edited content')
        
        const encryptionService = await getEncryptionService()
        if (encryptionService && encryptionService.isInitialized() && encryptionService.isUnlocked()) {
          try {
            // Get the room ID (channel_id or conversation_id)
            const roomId = originalMessage.channel_id || originalMessage.conversation_id
            if (!roomId) {
              throw new Error('Cannot determine room ID for re-encryption')
            }
            
            // For Megolm, we need to get current room members
            let recipientIds: string[] = []
            
            if (originalMessage.channel_id) {
              // Get server members for the channel
              const { data: channel } = await supabase
                .from('channels')
                .select('server_id')
                .eq('id', originalMessage.channel_id)
                .single()
              
              if (channel?.server_id) {
                const { data: members } = await supabase
                  .from('user_servers')
                  .select('user_id')
                  .eq('server_id', channel.server_id)
                recipientIds = members?.map(m => m.user_id) || []
              }
            } else if (originalMessage.conversation_id) {
              // Get conversation participants
              const { data: participants } = await supabase
                .from('conversation_participants')
                .select('user_id')
                .eq('conversation_id', originalMessage.conversation_id)
                .is('left_at', null)
              recipientIds = participants?.map(p => p.user_id) || []
            }
            
            if (!recipientIds.includes(currentUser.id)) {
              recipientIds.push(currentUser.id)
            }

            debug.log(`🔐 Re-encrypting with Megolm for room ${roomId.substring(0, 8)}...`)
            
            // Encrypt the new content with Megolm
            const encryptedData = await encryptionService.encryptMessage(newContent, roomId, recipientIds)
            finalContent = encryptedData.content
            encrypted = true
            encryptionMetadata = encryptedData.encryption_metadata
            debug.log(`✅ Edited message re-encrypted with Megolm`)
          } catch (error) {
            debug.error('❌ Re-encryption failed:', error)
            throw this.createError('ENCRYPTION_FAILED', 'Failed to re-encrypt edited message', error)
          }
        } else {
          throw this.createError('ENCRYPTION_SERVICE_UNAVAILABLE', 'Encryption not unlocked - enter recovery key')
        }
      }

      // Update the message with the new content (encrypted or plaintext)
      const { data: messages, error } = await supabase
        .from('messages')
        .update({ 
          content: finalContent,
          encrypted,
          encryption_metadata: encryptionMetadata,
          updated_at: new Date().toISOString(),
        })
        .eq('id', messageId)
        .select('*')

      if (error) throw this.createError('UPDATE_FAILED', error.message, error)

      const message = messages?.[0]
      if (!message) {
        throw this.createError('UPDATE_FAILED', 'Message not found or you do not have permission to edit it')
      }

      debug.log('✅ Message edited successfully (local only)')
      return message
    } catch (error) {
      debug.error('❌ Failed to edit message:', error)
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

      debug.log('✅ Message deleted successfully (local only)')
    } catch (error) {
      debug.error('❌ Failed to delete message:', error)
      throw error
    }
  }

  // =====================================================
  // REACTION MANAGEMENT (PURE LOCAL)
  // =====================================================

  /**
   * Toggle emoji reaction on a message (pure local database operation)
   */
  /**
   * Check if a string is a valid UUID
   * Uses permissive regex to handle Supabase-generated UUIDs which may not strictly follow RFC 4122
   */
  private isValidUUID(str: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    return uuidRegex.test(str)
  }

  /**
   * Toggle reaction on a message
   * Uses AuthContextService for efficient auth lookup
   * Supports both server emojis (UUID) and native Unicode emojis
   */
  async toggleReaction(
    messageId: string, 
    emojiId: string
  ): Promise<{ added: boolean; hadRaceCondition?: boolean }> {
    try {
      const profileId = await this.getCurrentUserProfileId()
      
      // Determine if this is a native emoji (not a UUID) or a server emoji (UUID)
      const isNativeEmoji = !this.isValidUUID(emojiId)
      
      debug.log(`🔄 Core: Toggling reaction: message=${messageId}, emoji=${emojiId}, native=${isNativeEmoji}, user=${profileId}`)

      // Build the match condition based on emoji type
      let existingReactionQuery = supabase
        .from('reactions')
        .select('id')
        .eq('message_id', messageId)
        .eq('user_id', profileId)
      
      if (isNativeEmoji) {
        existingReactionQuery = existingReactionQuery.eq('custom_emoji_content', emojiId)
      } else {
        existingReactionQuery = existingReactionQuery.eq('emoji_id', emojiId)
      }

      const { data: existingReaction } = await existingReactionQuery.maybeSingle()

      if (existingReaction) {
        // Remove reaction - build delete query based on emoji type
        let deleteQuery = supabase
          .from('reactions')
          .delete()
          .eq('message_id', messageId)
          .eq('user_id', profileId)
        
        if (isNativeEmoji) {
          deleteQuery = deleteQuery.eq('custom_emoji_content', emojiId)
        } else {
          deleteQuery = deleteQuery.eq('emoji_id', emojiId)
        }

        const { error } = await deleteQuery

        if (error) throw this.createError('REMOVE_REACTION_FAILED', error.message, error)
        
        debug.log('✅ Core: Reaction removed successfully')
        return { added: false }
      } else {
        // Add reaction - insert with either emoji_id or custom_emoji_content
        const reactionData: any = {
          message_id: messageId,
          user_id: profileId,
        }
        
        if (isNativeEmoji) {
          reactionData.custom_emoji_content = emojiId
        } else {
          reactionData.emoji_id = emojiId
        }
        
        const { error } = await supabase
          .from('reactions')
          .insert([reactionData])

        if (error) {
          // Handle race condition (duplicate constraint violation)
          if (error.code === '23505') {
            debug.log('🎯 Core: Race condition detected in reaction toggle')
            
            // Double-check current state after race condition
            // Double-check using the same query style as above
            let raceCheckQuery = supabase
              .from('reactions')
              .select('id')
              .eq('message_id', messageId)
              .eq('user_id', profileId)
            
            if (isNativeEmoji) {
              raceCheckQuery = raceCheckQuery.eq('custom_emoji_content', emojiId)
            } else {
              raceCheckQuery = raceCheckQuery.eq('emoji_id', emojiId)
            }
            
            const { data: nowExists } = await raceCheckQuery.maybeSingle()

            if (nowExists) {
              debug.log('✅ Core: Reaction was added by another process, treating as success')
              return { added: true, hadRaceCondition: true }
            } else {
              throw this.createError('RACE_CONDITION_ERROR', 'Unexpected duplicate error state')
            }
          }
          
          // Note: RLS policy issues should be resolved by migration 007's SECURITY DEFINER functions
          
          throw this.createError('ADD_REACTION_FAILED', error.message, error)
        }
        
        debug.log('✅ Core: Reaction added successfully')
        return { added: true }
      }
    } catch (error) {
      debug.error('❌ Core: Failed to toggle reaction:', error)
      throw error
    }
  }

  /**
   * Get reactions for a message using optimized database function (pure local)
   */
  async getMessageReactions(messageId: string): Promise<any[]> {
    try {
      debug.log(`🔄 Core: Fetching reactions for message: ${messageId}`)
      
      const { data: reactions, error } = await supabase
        .rpc('get_message_reactions', { message_id: messageId })

      if (error) {
        debug.error('❌ Core: Failed to fetch message reactions:', error)
        throw this.createError('FETCH_REACTIONS_FAILED', error.message, error)
      }

      const transformedReactions = reactions?.map(reaction => {
        // Native emoji (is_native=true) have no entry in the emojis table,
        // so emoji_id must be null — findReactionGroup relies on this to
        // distinguish UUID-based custom emoji from string-based native emoji.
        const isNative = reaction.emoji?.is_native === true
        return {
          emoji_id: isNative ? null : reaction.emoji.id,
          emoji: {
            id: reaction.emoji.id,
            name: reaction.emoji.name,
            url: reaction.emoji.url || '',
            content: reaction.emoji.content,
            is_native: isNative
          },
          count: reaction.count,
          reactions: Array.isArray(reaction.reactions) ? reaction.reactions : [],
          message_id_of_reactions: reaction.message_id_of_reactions
        }
      }) || []
      debug.log(`✅ Core: Fetched ${transformedReactions.length} reaction groups for message: ${messageId}`)
      return transformedReactions
    } catch (error) {
      debug.error('❌ Core: Error in getMessageReactions:', error)
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

      debug.log(`🔄 Core: Batch fetching reactions for ${messageIds.length} messages`)
      
      // Use the optimized database function
      const { data: reactions, error } = await supabase
        .rpc('get_batch_message_reactions', { message_ids: messageIds })

      if (error) {
        debug.error('❌ Core: Failed to batch fetch message reactions:', error)
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
        
        const isNative = !reaction.emoji_id && !!reaction.custom_emoji_content
        groupedReactions[messageId].push({
          emoji_id: reaction.emoji_id || null,
          emoji: {
            id: reaction.emoji_id || reaction.custom_emoji_content,
            name: reaction.emoji_name || reaction.custom_emoji_content || 'unknown',
            url: reaction.emoji_url || '',
            content: reaction.custom_emoji_content,
            is_native: isNative
          },
          count: reaction.reaction_count || 0,
          reactions: Array.isArray(reaction.users) ? reaction.users : []
        })
      })

      debug.log(`✅ Core: Batch fetched reactions for ${messageIds.length} messages (${reactions?.length || 0} reaction groups)`)
      return groupedReactions
    } catch (error) {
      debug.error('❌ Core: Error in getBatchMessageReactions:', error)
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
      
      debug.log(`✅ Core: Synced ${Object.keys(reactionsByMessage).length} message reactions to store cache`)
    } catch (error) {
      debug.warn('⚠️ Core: Failed to sync reactions to store cache:', error)
      // Don't throw - this is not critical to core functionality
    }
  }

  // =====================================================
  // MESSAGE LOADING (PURE LOCAL)
  // =====================================================

  /**
   * Load channel messages with pagination
   * 
   * Supports both local and federated (remote) channels:
   * - Local channels: Query local database directly
   * - Remote channels: Fetch from federation backend which proxies to remote server
   * 
   * NOTE: We trust Supabase to handle its own connection management.
   * No artificial timeouts - queries complete when they complete.
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

      debug.log(`🔄 Core: Loading messages for channel: ${channelId}`, { limit, before, after })

      // Check if this is a remote channel by looking up the server
      const { data: channel } = await supabase
        .from('channels')
        .select('id, is_remote, server_id')
        .eq('id', channelId)
        .maybeSingle()

      // If channel has is_remote flag or we need to check the server
      let isRemoteChannel = channel?.is_remote === true

      // Also check if the server is remote
      if (!isRemoteChannel && channel?.server_id) {
        const { data: server } = await supabase
          .from('servers')
          .select('is_local_server')
          .eq('id', channel.server_id)
          .maybeSingle()
        
        isRemoteChannel = server?.is_local_server === false
      }

      if (isRemoteChannel) {
        debug.log(`🌐 Channel ${channelId} is remote, fetching via federation backend`)
        return await this.loadRemoteChannelMessages(channelId, options)
      }

      // Local channel - use existing query
      // Filter out thread replies (messages with thread_id) - they only appear in thread view
      let query = supabase
        .from('messages')
        .select('*')
        .eq('channel_id', channelId)
        .is('thread_id', null)
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

      debug.log('📤 Executing message load query...')
      const { data: messages, error } = await query

      if (error) {
        debug.error('❌ Failed to load messages:', error)
        throw this.createError('LOAD_MESSAGES_FAILED', error.message, error)
      }

      const messageList = messages || []
      debug.log(`✅ Loaded ${messageList.length} messages from database for channel ${channelId}`)
      
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

      debug.log(`✅ Core: Loaded ${orderedMessages.length} messages with reactions for channel: ${channelId}`)
      
      // Process encrypted messages
      const { processMessageDecryption } = await import('@/utils/messageDecryption')
      const decryptedMessages = await processMessageDecryption(orderedMessages)
      
      return decryptedMessages
    } catch (error) {
      debug.error('❌ Core: Failed to load channel messages:', error)
      throw error
    }
  }

  /**
   * Load messages from a remote (federated) channel via federation backend
   */
  private async loadRemoteChannelMessages(
    channelId: string,
    options: {
      limit?: number
      before?: string
      after?: string
      signal?: AbortSignal
    } = {}
  ): Promise<Message[]> {
    const { limit = 50, before } = options

    // Prefer local DB first — AP federation inserts messages with proper structured
    // content (preserving custom emojis, etc.). The remote API re-parses HTML and
    // loses that structure. Only fall back to remote fetch if local DB is empty.
    const localMessages = await this.loadCachedRemoteMessages(channelId, options)
    if (localMessages.length > 0) {
      debug.log(`📦 Using ${localMessages.length} locally-synced messages for remote channel (AP federation)`)

      // Batch load reactions from local DB
      const messageIds = localMessages.map(m => m.id).filter(Boolean)
      if (messageIds.length > 0) {
        const reactionsByMessage = await this.getBatchMessageReactions(messageIds)
        localMessages.forEach(message => {
          message.reactions = reactionsByMessage[message.id] || []
        })
        await this.populateReactionsStoreCache(reactionsByMessage)
      }

      return localMessages
    }

    // No local messages — fetch from remote server API
    try {
      const params = new URLSearchParams()
      params.append('limit', String(limit))
      if (before) params.append('before', before)

      const response = await fetch(`/api/federation/channels/${channelId}/messages?${params}`, {
        headers: {
          'Accept': 'application/json',
        },
      })

      if (!response.ok) {
        debug.warn(`Failed to fetch remote messages: ${response.status}`)
        return []
      }

      const data = await response.json()
      const remoteMessages = data.messages || []

      debug.log(`📨 Fetched ${remoteMessages.length} messages from remote channel (source: ${data.source})`)

      // Transform to our message format
      const messages = remoteMessages.map((msg: any) => ({
        id: msg.id,
        channel_id: channelId,
        user_id: msg.author?.id,
        content: this.parseRemoteContent(msg.content),
        created_at: msg.created_at,
        updated_at: msg.updated_at,
        metadata: msg.metadata || {},
        author: msg.author,
        reactions: msg.reactions || [],
      }))

      // Reverse to get oldest-first for display
      const orderedMessages = messages.reverse()

      // Populate reactions store with data from response or local cache
      const messageIds = orderedMessages.map((m: Message) => m.id).filter((id: string) => id)
      
      if (messageIds.length > 0) {
        const hasReactionsFromResponse = orderedMessages.some((m: Message) => m.reactions && m.reactions.length > 0)
        
        if (hasReactionsFromResponse) {
          const reactionsByMessage: Record<string, any[]> = {}
          orderedMessages.forEach((m: Message) => {
            if (m.reactions && m.reactions.length > 0) {
              reactionsByMessage[m.id] = m.reactions.map((r: any) => ({
                emoji_id: r.emoji?.id || r.emoji_id,
                emoji: {
                  id: r.emoji?.id || r.emoji_id,
                  name: r.emoji?.name || r.emoji_name,
                  url: r.emoji?.url,
                  is_native: r.emoji?.is_native ?? !r.emoji?.url,
                },
                count: r.count || 1,
                reactions: r.reactions || [],
                message_id_of_reactions: m.id,
              }))
            }
          })
          await this.populateReactionsStoreCache(reactionsByMessage)
        } else {
          const reactionsByMessage = await this.getBatchMessageReactions(messageIds)
          orderedMessages.forEach((message: Message) => {
            message.reactions = reactionsByMessage[message.id] || []
          })
          await this.populateReactionsStoreCache(reactionsByMessage)
        }
      }

      return orderedMessages
    } catch (error) {
      debug.error('❌ Failed to fetch remote channel messages:', error)
      return []
    }
  }

  /**
   * Load cached messages for a remote channel (fallback)
   */
  private async loadCachedRemoteMessages(
    channelId: string,
    options: { limit?: number; before?: string } = {}
  ): Promise<Message[]> {
    const { limit = 50, before } = options

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

    const { data: messages } = await query
    debug.log(`📦 Loaded ${(messages || []).length} cached messages for remote channel`)
    
    return (messages || []).reverse()
  }

  /**
   * Parse remote message content (ActivityPub HTML to our format)
   * Preserves custom emojis as images and converts common HTML to our format
   */
  private parseRemoteContent(content: string | any[]): any[] {
    // If already in our format, return as-is
    if (Array.isArray(content)) {
      return content
    }

    // If null/undefined, return empty
    if (!content) {
      debug.log('⚠️ parseRemoteContent received null/undefined content')
      return [{ type: 'text', text: '' }]
    }

    // If HTML string, convert to our format while preserving important elements
    if (typeof content === 'string') {
      // Debug log if content has emojis
      if (content.includes('<img') || content.includes('emoji')) {
        debug.log('🔍 parseRemoteContent input (first 300 chars):', content.substring(0, 300))
      }
      const result: any[] = []
      
      let processedContent = content
      
      // Replace <br> with newlines
      processedContent = processedContent.replace(/<br\s*\/?>/gi, '\n')
      
      // Replace <p> tags with newlines
      processedContent = processedContent.replace(/<\/p>\s*<p>/gi, '\n\n')
      processedContent = processedContent.replace(/<\/?p>/gi, '')
      
      // Extract ALL img tags that look like emojis (any img with src and reasonable attributes)
      // More permissive pattern to catch various emoji formats:
      // - <img class="emoji" src="..." alt=":name:" />
      // - <img src="..." title=":name:" />
      // - <img alt=":name:" src="..." />
      // - <img data-emoji="name" src="..." />
      const imgRegex = /<img\s+([^>]*)>/gi
      
      processedContent = processedContent.replace(imgRegex, (match, attrs) => {
        // Extract src
        const srcMatch = attrs.match(/src=["']([^"']+)["']/i)
        if (!srcMatch) return match // Not a valid image, keep as-is
        
        const src = srcMatch[1]
        
        // Check if it's likely an emoji (has emoji class, or emoji in URL, or custom-emoji in URL)
        const isEmoji = /class=["'][^"']*emoji/i.test(attrs) ||
                       /emoji|custom[-_]?emoji/i.test(src) ||
                       /\/emojis?\//i.test(src) ||
                       /alt=["']:?[a-zA-Z0-9_-]+:?["']/i.test(attrs)
        
        if (!isEmoji) return match // Not an emoji, keep as-is
        
        // Extract name from alt, title, or data attributes
        const altMatch = attrs.match(/alt=["']:?([^"':]+):?["']/i)
        const titleMatch = attrs.match(/title=["']:?([^"':]+):?["']/i)
        const dataMatch = attrs.match(/data-(?:emoji|shortcode)=["']([^"']+)["']/i)
        
        const emojiName = (altMatch?.[1] || titleMatch?.[1] || dataMatch?.[1] || 'emoji').trim()
        
        // Return a placeholder
        return `[REMOTE_EMOJI:${emojiName}:${src}]`
      })
      
      // Also handle Misskey/Mastodon style emoji: <span class="emoji">:name:</span>
      processedContent = processedContent.replace(/<span[^>]*class="[^"]*emoji[^"]*"[^>]*>([^<]+)<\/span>/gi, (match, emojiCode) => {
        return emojiCode // Keep the :emoji_name: text for now
      })
      
      // Strip remaining HTML tags
      const text = processedContent.replace(/<[^>]*>/g, '').trim()
      
      // Parse the text for remote emoji placeholders
      if (text.includes('[REMOTE_EMOJI:')) {
        // Split while keeping the delimiter
        const parts = text.split(/(\[REMOTE_EMOJI:[^\]]+\])/g)
        for (const part of parts) {
          // Match: [REMOTE_EMOJI:name:url]
          const emojiMatch = part.match(/\[REMOTE_EMOJI:([^:]+):(.+)\]/)
          if (emojiMatch) {
            const emojiName = emojiMatch[1].replace(/:/g, '').trim()
            const emojiUrl = emojiMatch[2].trim()
            
            result.push({
              type: 'emoji',
              emoji: {
                id: `remote:${emojiName}`,
                name: emojiName,
                url: emojiUrl,
              }
            })
          } else if (part.trim()) {
            result.push({ type: 'text', text: part })
          }
        }
      } else if (text) {
        result.push({ type: 'text', text })
      }
      
      return result.length > 0 ? result : [{ type: 'text', text: '' }]
    }

    return [{ type: 'text', text: '' }]
  }

  /**
   * Load conversation messages with pagination (pure local)
   * 
   * NOTE: We trust Supabase to handle its own connection management.
   * No artificial timeouts - queries complete when they complete.
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

      debug.log(`🔄 Core: Loading messages for conversation: ${conversationId}`)

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

      if (error) {
        throw this.createError('LOAD_MESSAGES_FAILED', error.message, error)
      }

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

      debug.log(`✅ Core: Loaded ${orderedMessages.length} messages with reactions for conversation: ${conversationId}`)
      
      // Process encrypted messages
      const { processMessageDecryption } = await import('@/utils/messageDecryption')
      const decryptedMessages = await processMessageDecryption(orderedMessages)
      
      return decryptedMessages
    } catch (error) {
      debug.error('❌ Core: Failed to load conversation messages:', error)
      throw error
    }
  }

  /**
   * Load a single message by ID (pure local)
   */
  async loadMessage(messageId: string): Promise<Message | null> {
    try {
      debug.log(`🔄 Core: Loading message: ${messageId}`)

      const { data: message, error } = await supabase
        .from('messages')
        .select('*')
        .eq('id', messageId)
        .single()

      if (error) {
        if (error.code === 'PGRST116') {
          debug.log(`ℹ️ Core: Message not found: ${messageId}`)
          return null
        }
        throw this.createError('LOAD_MESSAGE_FAILED', error.message, error)
      }

      debug.log(`✅ Core: Loaded message: ${messageId}`)
      return message
    } catch (error) {
      debug.error('❌ Core: Failed to load message:', error)
      throw error
    }
  }

  // =====================================================
  // HELPER METHODS (PURE LOCAL)
  // =====================================================

  /**
   * Get current user's profile ID
   * Uses centralized AuthContextService to avoid duplicate auth lookups
   */
  private async getCurrentUserProfileId(): Promise<string> {
    try {
      return await authContextService.getCurrentProfileId()
    } catch (error) {
      debug.error('❌ Core: Failed to get current user profile ID:', error)
      throw this.createError('AUTH_REQUIRED', 'User not authenticated')
    }
  }

  /**
   * Send a system message in a channel (e.g., thread creation announcements).
   * System messages bypass encryption and are rendered specially by MessageDisplay.
   */
  async sendSystemMessage(
    channelId: string,
    content: MessagePart[],
    metadata: Record<string, any>
  ): Promise<{ error: string | null }> {
    try {
      const userId = await this.getCurrentProfileId()
      
      const { error } = await supabase.from('messages').insert({
        channel_id: channelId,
        user_id: userId,
        content,
        is_system: true,
        metadata,
      })

      if (error) {
        debug.error('Failed to send system message:', error)
        return { error: error.message }
      }
      return { error: null }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      debug.error('Failed to send system message:', msg)
      return { error: msg }
    }
  }

  private createError(code: string, message: string, details?: any): CoreMessageServiceError {
    return { code, message, details }
  }
}

// Export singleton instance
export const coreMessageService = CoreMessageService.getInstance()