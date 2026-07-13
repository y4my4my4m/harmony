/** Local message CRUD, reactions, and loading. */
import { supabase } from '@/supabase'
import { apiUrl } from '@/services/instanceConfig';
import type { Message, MessagePart } from '@/types'
import { userDataService } from '@/services/userDataService'
import { authContextService } from '@/services/AuthContextService'
import { debug } from '@/utils/debug'
import { discordCustomEmojiUrlFromIdentifier } from '@/utils/emojiUtils'
import {
  DEFAULT_MAX_MESSAGE_TEXT_LENGTH,
  MESSAGE_TEXT_HARD_CEILING,
  messageTextLength,
} from '@/utils/messageContentUtils'

// Lazy load and auto-initialize Megolm encryption service
let megolmEncryptionService: any = null
async function getEncryptionService() {
  if (!megolmEncryptionService) {
    try {
      const module = await import('@/services/encryption/MegolmMessageEncryptionService')
      megolmEncryptionService = module.megolmMessageEncryptionService
    } catch (error) {
      debug.warn('Megolm encryption service not available:', error)
      megolmEncryptionService = null
    }
  }
  if (megolmEncryptionService && !megolmEncryptionService.isInitialized()) {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.user?.id) {
        debug.log('Lazy-initializing encryption service...')
        await megolmEncryptionService.initialize(session.user.id)
      }
    } catch (error) {
      debug.warn('Failed to lazy-initialize encryption:', error)
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

/**
 * Send-time encryption policy options.
 *
 * Default policy is **fail closed**: if a channel or DM is configured for
 * encryption and encryption is unavailable or fails, the send is rejected
 * with an ENCRYPTION_* error code. UIs MUST surface that error to the user
 * and obtain explicit consent before retrying with `allowPlaintextFallback`.
 */
export interface SendOptions {
  /**
   * If true, callers acknowledge the encryption attempt may fail and the
   * message will be sent in plaintext anyway. Must be the result of a
   * deliberate, user-confirmed action (e.g. "Send unencrypted anyway").
   * Has no effect when the server enforces `encryption_mode = 'required'`.
   */
  allowPlaintextFallback?: boolean
}

export class CoreMessageService {
  private static instance: CoreMessageService
  
  static getInstance(): CoreMessageService {
    if (!this.instance) {
      this.instance = new CoreMessageService()
    }
    return this.instance
  }

  /**
   * Fetch the admin-configured max message length from `instance_config`.
   * Falls back to `DEFAULT_MAX_MESSAGE_TEXT_LENGTH` if the row is missing
   * or unparseable. Always clamped to `[1, MESSAGE_TEXT_HARD_CEILING]` so a
   * misconfigured admin can't either disable the limit (0) or push it
   * past the DB-side hard ceiling (which would then reject the insert
   * with a less informative error).
   */
  private async getMaxMessageLength(): Promise<number> {
    const { data } = await supabase
      .from('instance_config')
      .select('config_value')
      .eq('config_key', 'max_message_length')
      .maybeSingle()
    const raw = data?.config_value
    const parsed =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string'
          ? parseInt(raw, 10)
          : NaN
    const value = !Number.isNaN(parsed) && parsed >= 1
      ? parsed
      : DEFAULT_MAX_MESSAGE_TEXT_LENGTH
    return Math.min(value, MESSAGE_TEXT_HARD_CEILING)
  }

  /**
   * Reject message payloads whose combined text length exceeds the admin
   * soft limit (`instance_config.max_message_length`). Mirrors the
   * client-side check in `MessageInput.vue` so the same number is the
   * authoritative limit at every layer.
   *
   * The check runs on the *plaintext* content, before any encryption
   * step, so an attacker who modifies the client cannot bypass it by
   * re-encrypting the over-limit payload locally. The DB-side CHECK
   * constraint provides an absolute upper bound at `MESSAGE_TEXT_HARD_CEILING`
   * for cases where this code path is skipped (direct PostgREST insert,
   * bot gateway, federation backend).
   */
  private async assertContentWithinLimit(content: MessagePart[]): Promise<void> {
    const limit = await this.getMaxMessageLength()
    const len = messageTextLength(content)
    if (len > limit) {
      throw this.createError(
        'MESSAGE_TOO_LONG',
        `Message is too long (${len.toLocaleString()} / ${limit.toLocaleString()} characters).`,
      )
    }
  }

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
   *
   * Encryption policy:
   *   - `disabled`: always plaintext (no opt-in needed).
   *   - `required`: must encrypt. Lock/setup/encrypt failure rejects the send.
   *     `options.allowPlaintextFallback` is ignored.
   *   - `optional`: tries to encrypt when keys are unlocked. Without
   *     `options.allowPlaintextFallback === true`, missing keys, locked
   *     encryption, or encryption errors reject the send (`fail closed`).
   *     With explicit opt-in, the message falls back to plaintext.
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
      // Enforce max message length BEFORE encryption so the error message
      // points to the actual problem ("too long") rather than a downstream
      // ciphertext-size failure.
      await this.assertContentWithinLimit(content)

      // Enforce max media attachments per message (instance config, default 20)
      const fileParts = content.filter((p: any) => p?.type === 'file')
      const maxMedia = await this.getMaxMediaAttachments()
      if (fileParts.length > maxMedia) {
        throw this.createError('TOO_MANY_ATTACHMENTS', `Maximum ${maxMedia} media attachments per message`)
      }

      const currentUser = userDataService.getCurrentUser()
      if (!currentUser?.id) {
        throw this.createError('AUTH_REQUIRED', 'User not authenticated')
      }

      let finalContent = content
      let encrypted = false
      let encryptionMetadata = null
      const allowFallback = options?.allowPlaintextFallback === true

      const { data: serverSettings } = await supabase
        .from('server_encryption_settings')
        .select('encryption_mode')
        .eq('server_id', serverId)
        .maybeSingle()
      
      const encryptionMode = serverSettings?.encryption_mode || 'disabled'
      debug.log(`Server encryption mode: ${encryptionMode}`)

      if (encryptionMode === 'disabled') {
        debug.log('ℹServer has encryption disabled - sending plaintext')
      } else {
        // Encryption is optional or required - check if user can encrypt
        const encryptionService = await getEncryptionService()
        
        if (encryptionService && encryptionService.isInitialized()) {
          const hasRecoveryKey = await encryptionService.hasRecoveryKey()
          const isUnlocked = encryptionService.isUnlocked()
          
          debug.log(`Encryption check: hasRecoveryKey=${hasRecoveryKey}, isUnlocked=${isUnlocked}`)
          
          if (hasRecoveryKey && isUnlocked) {
            try {
              debug.log('Megolm encryption active - encrypting message for channel')
              debug.log(`Channel (room): ${channelId}`)
              
              const { data: members } = await supabase
                .from('user_servers')
                .select('user_id')
                .eq('server_id', serverId)
              
              const recipientIds = members?.map(m => m.user_id) || []
              if (!recipientIds.includes(currentUser.id)) {
                recipientIds.push(currentUser.id)
              }
              
              debug.log(`Encrypting for channel with ${recipientIds.length} members`)
              
              // Encrypt message with Megolm (channel-wide session key)
              const encryptedData = await encryptionService.encryptMessage(content, channelId, recipientIds)
              finalContent = encryptedData.content
              encrypted = true
              encryptionMetadata = encryptedData.encryption_metadata
              debug.log(`Message encrypted with Megolm (session: ${encryptionMetadata.session_id?.substring(0, 8)}...)`)
            } catch (error) {
              debug.error('Encryption failed:', error)
              if (encryptionMode === 'required') {
                throw this.createError('ENCRYPTION_REQUIRED', 'Server requires encryption but encryption failed', error)
              }
              if (!allowFallback) {
                // Fail closed: this channel is configured for encryption but
                // we failed to encrypt. UI must explicitly retry with
                // allowPlaintextFallback after the user confirms.
                throw this.createError('ENCRYPTION_FAILED_NO_FALLBACK',
                  'Encryption failed and plaintext fallback was not authorized', error)
              }
              debug.warn('User-authorized plaintext fallback - sending unencrypted')
              this.markPlaintextOverride(extraMetadata = extraMetadata || {}, 'optional_encrypt_failed')
            }
          } else if (encryptionMode === 'required') {
            // Required server, user can't encrypt: NON-overridable. Always raise
            // ENCRYPTION_REQUIRED (never ENCRYPTION_LOCKED, which the UI treats as
            // fallback-eligible and would wrongly offer plaintext). Message text
            // still tells the user whether to set up or unlock.
            if (!hasRecoveryKey) {
              throw this.createError('ENCRYPTION_REQUIRED', 'This server requires encryption. Set up encryption in Settings first.')
            } else {
              throw this.createError('ENCRYPTION_REQUIRED', 'This server requires encryption. Unlock encryption with your recovery key first.')
            }
          } else {
            // Optional encryption + user cannot encrypt:
            //  (a) hasRecoveryKey && !isUnlocked → opted in but locked; fail
            //      closed (don't silently downgrade), UI prompts to unlock.
            //  (b) !hasRecoveryKey → never opted in; plaintext is within policy,
            //      send silently (no security benefit to prompting).
            if (hasRecoveryKey && !isUnlocked) {
              if (!allowFallback) {
                throw this.createError('ENCRYPTION_LOCKED',
                  'This channel supports encryption but your keys are locked. Unlock encryption to send encrypted, or confirm an unencrypted send.')
              }
              debug.warn('User-authorized plaintext fallback - encryption locked')
              this.markPlaintextOverride(extraMetadata = extraMetadata || {}, 'optional_encryption_locked')
            } else {
              // No recovery key set up - silent plaintext, no prompt.
              debug.log('ℹOptional encryption + no recovery key - sending plaintext')
              this.markPlaintextOverride(extraMetadata = extraMetadata || {}, 'optional_no_recovery_key')
            }
          }
        } else if (encryptionMode === 'required') {
          throw this.createError('ENCRYPTION_REQUIRED', 'This server requires encryption. Set up encryption in Settings first.')
        } else {
          // Optional mode + encryption service entirely unavailable.
          // Same reasoning as case (b) above: user has not opted in to
          // encryption on this server, so just send plaintext.
          debug.log('ℹOptional encryption + service unavailable - sending plaintext')
          this.markPlaintextOverride(extraMetadata = extraMetadata || {}, 'optional_service_unavailable')
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

      debug.log('Inserting message to database:', { ...messageData, content: encrypted ? '[encrypted]' : messageData.content })
      
      const { data: message, error } = await supabase
        .from('messages')
        .insert(messageData)
        .select('*')
        .single()

      if (error) {
        debug.error('DATABASE INSERT FAILED:', error)
        throw this.createError('INSERT_FAILED', error.message, error)
      }
      
      if (!message) {
        debug.error('No message returned from insert!')
        throw this.createError('INSERT_FAILED', 'No message returned from database')
      }

      debug.log('Message inserted to database successfully:', message.id)
      debug.log('Returned message:', message)
      return message
    } catch (error) {
      debug.error('Failed to send channel message:', error)
      throw error
    }
  }

  /**
   * Send a DM message.
   *
   * @param options.isSystem - If true, stores as system message (no encryption, not federated)
   * @param options.allowPlaintextFallback - If true AND the conversation is
   *   marked encrypted but the sender cannot encrypt (locked / failed / no
   *   keys), send plaintext anyway. Must be the result of explicit user
   *   confirmation. Default policy is fail closed: the send is rejected
   *   with an ENCRYPTION_* error so the UI can prompt for consent.
   */
  async sendDMMessage(
    conversationId: string,
    content: MessagePart[],
    replyTo?: string,
    options?: { isSystem?: boolean; allowPlaintextFallback?: boolean },
    extraMetadata?: Record<string, any>
  ): Promise<Message> {
    try {
      // Enforce max media attachments per message (instance config, default 20)
      const isSystem = options?.isSystem ?? false
      const allowFallback = options?.allowPlaintextFallback === true
      if (!isSystem) {
        // Enforce max message length for user-authored DMs. System messages
        // (group_created etc.) are server-generated and tightly bounded, so
        // we don't need to validate them.
        await this.assertContentWithinLimit(content)

        const fileParts = content.filter((p: any) => p?.type === 'file')
        const maxMedia = await this.getMaxMediaAttachments()
        if (fileParts.length > maxMedia) {
          throw this.createError('TOO_MANY_ATTACHMENTS', `Maximum ${maxMedia} media attachments per message`)
        }
      }

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
        debug.log('System message sent successfully')
        return message
      }

      const { data: convSettings } = await supabase
        .from('conversation_encryption_settings')
        .select('encryption_enabled')
        .eq('conversation_id', conversationId)
        .maybeSingle()

      const conversationEncryptionEnabled = convSettings?.encryption_enabled === true
      debug.log(`Conversation encryption setting: ${conversationEncryptionEnabled ? 'enabled' : 'disabled'}`)

      if (conversationEncryptionEnabled) {
        const encryptionService = await getEncryptionService()
        if (encryptionService && encryptionService.isInitialized()) {
          const hasRecoveryKey = await encryptionService.hasRecoveryKey()
          const isUnlocked = encryptionService.isUnlocked()

          if (hasRecoveryKey && isUnlocked) {
            try {
              debug.log('Megolm encryption active - encrypting DM')
              debug.log(`Conversation (room): ${conversationId}`)

              const { data: participants } = await supabase
                .from('conversation_participants')
                .select('user_id')
                .eq('conversation_id', conversationId)
                .is('left_at', null)

              const recipientIds = participants?.map(p => p.user_id) || []
              if (!recipientIds.includes(currentUser.id)) {
                recipientIds.push(currentUser.id)
              }

              debug.log(`Encrypting DM for ${recipientIds.length} participants`)

              // Encrypt message with Megolm (conversation-wide session key)
              const encryptedData = await encryptionService.encryptMessage(content, conversationId, recipientIds)
              finalContent = encryptedData.content
              encrypted = true
              encryptionMetadata = encryptedData.encryption_metadata
              debug.log(`DM encrypted with Megolm (session: ${encryptionMetadata.session_id?.substring(0, 8)}...)`)
            } catch (error) {
              debug.error('DM encryption failed:', error)
              if (!allowFallback) {
                window.dispatchEvent(new CustomEvent('encryption-fallback', {
                  detail: { type: 'dm', conversationId, error: String(error), failClosed: true }
                }))
                throw this.createError('ENCRYPTION_FAILED_NO_FALLBACK',
                  'DM encryption failed and plaintext fallback was not authorized', error)
              }
              debug.warn('User-authorized plaintext fallback - sending DM unencrypted')
              this.markPlaintextOverride(extraMetadata = extraMetadata || {}, 'dm_encrypt_failed')
            }
          } else if (hasRecoveryKey && !isUnlocked) {
            if (!allowFallback) {
              throw this.createError('ENCRYPTION_LOCKED',
                'This conversation is encrypted but your keys are locked. Unlock encryption to send encrypted, or confirm an unencrypted send.')
            }
            debug.warn('User-authorized plaintext fallback - DM keys locked')
            this.markPlaintextOverride(extraMetadata = extraMetadata || {}, 'dm_encryption_locked')
          } else {
            if (!allowFallback) {
              throw this.createError('ENCRYPTION_UNAVAILABLE',
                'This conversation is encrypted but you have not set up a recovery key. Set up encryption to send encrypted, or confirm an unencrypted send.')
            }
            debug.warn('User-authorized plaintext fallback - DM no recovery key')
            this.markPlaintextOverride(extraMetadata = extraMetadata || {}, 'dm_no_recovery_key')
          }
        } else {
          if (!allowFallback) {
            throw this.createError('ENCRYPTION_UNAVAILABLE',
              'This conversation is encrypted but the encryption service is unavailable. Confirm an unencrypted send to continue.')
          }
          debug.warn('User-authorized plaintext fallback - DM encryption service unavailable')
          this.markPlaintextOverride(extraMetadata = extraMetadata || {}, 'dm_service_unavailable')
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

      debug.log('DM message sent successfully (local only)')
      return message
    } catch (error) {
      debug.error('Failed to send DM message:', error)
      throw error
    }
  }

  /**
   * Edit a message (pure local update)
   */
  async editMessage(messageId: string, newContent: MessagePart[]): Promise<Message> {
    try {
      // Enforce max length on edits too - otherwise a user could send a
      // tiny message and grow it past the limit via subsequent edits.
      await this.assertContentWithinLimit(newContent)

      // Enforce max media attachments per message (instance config, default 20)
      const fileParts = newContent.filter((p: any) => p?.type === 'file')
      const maxMedia = await this.getMaxMediaAttachments()
      if (fileParts.length > maxMedia) {
        throw this.createError('TOO_MANY_ATTACHMENTS', `Maximum ${maxMedia} media attachments per message`)
      }

      const currentUser = userDataService.getCurrentUser()
      if (!currentUser?.id) {
        throw this.createError('AUTH_REQUIRED', 'User not authenticated')
      }

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

      if (originalMessage.encrypted && originalMessage.encryption_metadata) {
        debug.log('Original message was encrypted - re-encrypting edited content')
        
        const encryptionService = await getEncryptionService()
        if (encryptionService && encryptionService.isInitialized() && encryptionService.isUnlocked()) {
          try {
            const roomId = originalMessage.channel_id || originalMessage.conversation_id
            if (!roomId) {
              throw new Error('Cannot determine room ID for re-encryption')
            }
            
            // Megolm needs the current room members
            let recipientIds: string[] = []
            
            if (originalMessage.channel_id) {
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

            debug.log(`Re-encrypting with Megolm for room ${roomId.substring(0, 8)}...`)
            
            const encryptedData = await encryptionService.encryptMessage(newContent, roomId, recipientIds)
            finalContent = encryptedData.content
            encrypted = true
            encryptionMetadata = encryptedData.encryption_metadata
            debug.log(`Edited message re-encrypted with Megolm`)
          } catch (error) {
            debug.error('Re-encryption failed:', error)
            throw this.createError('ENCRYPTION_FAILED', 'Failed to re-encrypt edited message', error)
          }
        } else {
          throw this.createError('ENCRYPTION_SERVICE_UNAVAILABLE', 'Encryption not unlocked - enter recovery key')
        }
      }

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

      debug.log('Message edited successfully (local only)')
      return message
    } catch (error) {
      debug.error('Failed to edit message:', error)
      throw error
    }
  }

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

      debug.log('Message deleted successfully (local only)')
    } catch (error) {
      debug.error('Failed to delete message:', error)
      throw error
    }
  }

  // Permissive regex: Supabase-generated UUIDs may not strictly follow RFC 4122.
  private isValidUUID(str: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    return uuidRegex.test(str)
  }

  // Supports both server emojis (UUID) and native Unicode emojis.
  async toggleReaction(
    messageId: string, 
    emojiId: string
  ): Promise<{ added: boolean; hadRaceCondition?: boolean }> {
    try {
      const profileId = await this.getCurrentUserProfileId()
      
      const isNativeEmoji = !this.isValidUUID(emojiId)
      
      debug.log(`Core: Toggling reaction: message=${messageId}, emoji=${emojiId}, native=${isNativeEmoji}, user=${profileId}`)

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
        
        debug.log('Core: Reaction removed successfully')
        return { added: false }
      } else {
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
            debug.log('Core: Race condition detected in reaction toggle')
            
            // Double-check current state after race condition
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
              debug.log('Core: Reaction was added by another process, treating as success')
              return { added: true, hadRaceCondition: true }
            } else {
              throw this.createError('RACE_CONDITION_ERROR', 'Unexpected duplicate error state')
            }
          }
          
          // Note: RLS policy issues should be resolved by migration 007's SECURITY DEFINER functions
          
          throw this.createError('ADD_REACTION_FAILED', error.message, error)
        }
        
        debug.log('Core: Reaction added successfully')
        return { added: true }
      }
    } catch (error) {
      debug.error('Core: Failed to toggle reaction:', error)
      throw error
    }
  }

  async getMessageReactions(messageId: string): Promise<any[]> {
    try {
      debug.log(`Core: Fetching reactions for message: ${messageId}`)
      
      const { data: reactions, error } = await supabase
        .rpc('get_message_reactions', { message_id: messageId })

      if (error) {
        debug.error('Core: Failed to fetch message reactions:', error)
        throw this.createError('FETCH_REACTIONS_FAILED', error.message, error)
      }

      const transformedReactions = reactions?.map((reaction: any) => {
        // Prefer the url the RPC surfaced from metadata.remote_emoji_url (correct
        // png/gif ext). Rebuild from a discord:name:id identifier only as a
        // fallback for rows predating metadata storage. Native = no image url.
        const url =
          reaction.emoji?.url ||
          discordCustomEmojiUrlFromIdentifier(reaction.emoji?.content) ||
          ''
        const isNative = !url
        return {
          emoji_id: isNative ? null : reaction.emoji.id,
          emoji: {
            id: reaction.emoji.id,
            name: reaction.emoji.name,
            url,
            content: reaction.emoji.content,
            is_native: isNative
          },
          count: reaction.count,
          current_user_reacted: reaction.current_user_reacted === true,
          reactions: Array.isArray(reaction.reactions) ? reaction.reactions : [],
          message_id_of_reactions: reaction.message_id_of_reactions
        }
      }) || []
      debug.log(`Core: Fetched ${transformedReactions.length} reaction groups for message: ${messageId}`)
      return transformedReactions
    } catch (error) {
      debug.error('Core: Error in getMessageReactions:', error)
      throw error
    }
  }

  // Uses a database function to avoid an N+1 query per message.
  async getBatchMessageReactions(messageIds: string[]): Promise<Record<string, any[]>> {
    try {
      if (messageIds.length === 0) {
        return {}
      }

      debug.log(`Core: Batch fetching reactions for ${messageIds.length} messages`)

      const { data: reactions, error } = await supabase
        .rpc('get_batch_message_reactions', { message_ids: messageIds })

      if (error) {
        debug.error('Core: Failed to batch fetch message reactions:', error)
        throw this.createError('BATCH_FETCH_REACTIONS_FAILED', error.message, error)
      }

      const groupedReactions = this.groupReactionRows(messageIds, reactions || [])

      debug.log(`Core: Batch fetched reactions for ${messageIds.length} messages (${reactions?.length || 0} reaction groups)`)
      return groupedReactions
    } catch (error) {
      debug.error('Core: Error in getBatchMessageReactions:', error)
      throw error
    }
  }

  /**
   * Map raw reaction rows (shape of get_batch_message_reactions /
   * get_message_page.reactions) into per-message reaction groups.
   */
  private groupReactionRows(messageIds: string[], rows: any[]): Record<string, any[]> {
    const groupedReactions: Record<string, any[]> = {}

    messageIds.forEach(messageId => {
      groupedReactions[messageId] = []
    })

    rows.forEach((reaction: any) => {
      const messageId = reaction.message_id

      if (!groupedReactions[messageId]) {
        groupedReactions[messageId] = []
      }

      // The batch RPC surfaces emoji_url from metadata.remote_emoji_url too;
      // the previous code marked every emoji_id-less reaction native, which
      // suppressed the image even when a url existed. Native = no image url.
      const url =
        reaction.emoji_url ||
        discordCustomEmojiUrlFromIdentifier(reaction.custom_emoji_content) ||
        ''
      const isNative = !url
      groupedReactions[messageId].push({
        emoji_id: reaction.emoji_id || null,
        emoji: {
          id: reaction.emoji_id || reaction.custom_emoji_content,
          name: reaction.emoji_name || reaction.custom_emoji_content || 'unknown',
          url,
          content: reaction.custom_emoji_content,
          is_native: isNative
        },
        count: reaction.reaction_count || 0,
        current_user_reacted: reaction.current_user_reacted === true,
        reactions: Array.isArray(reaction.users) ? reaction.users : []
      })
    })

    return groupedReactions
  }

  /**
   * Fast path: load a message page (messages + reactions) in ONE round trip
   * via the get_message_page RPC. Returns null when the RPC is unavailable
   * (e.g. migration not applied on a self-hosted instance) so callers can
   * fall back to the legacy multi-query load.
   */
  private async tryLoadMessagePage(params: {
    channelId?: string
    conversationId?: string
    limit: number
    before?: string
  }): Promise<{ messages: any[]; reactionsByMessage: Record<string, any[]> } | null> {
    try {
      const { data, error } = await supabase.rpc('get_message_page', {
        p_channel_id: params.channelId ?? null,
        p_conversation_id: params.conversationId ?? null,
        p_limit: params.limit,
        p_before: params.before ?? null
      })

      if (error) {
        debug.warn('Core: get_message_page RPC unavailable, using legacy multi-query load:', error.message)
        return null
      }

      const messages: any[] = data?.messages || []
      const messageIds = messages.map((m: any) => m.id)
      const reactionsByMessage = this.groupReactionRows(messageIds, data?.reactions || [])
      return { messages, reactionsByMessage }
    } catch (error) {
      debug.warn('Core: get_message_page RPC failed, using legacy multi-query load:', error)
      return null
    }
  }

  private async populateReactionsStoreCache(reactionsByMessage: Record<string, any[]>): Promise<void> {
    try {
      // Dynamically import to avoid circular dependencies
      const { useReactionsStore } = await import('@/stores/useReactions')
      const reactionsStore = useReactionsStore()
      
      reactionsStore.bulkSetReactions(reactionsByMessage)
      
      debug.log(`Core: Synced ${Object.keys(reactionsByMessage).length} message reactions to store cache`)
    } catch (error) {
      debug.warn('Core: Failed to sync reactions to store cache:', error)
      // Don't throw - this is not critical to core functionality
    }
  }

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
      /**
       * Whether the channel is remote (federated). Callers that already hold
       * the channel/server in a store should pass this to skip two lookup
       * round trips. When undefined, falls back to resolving from the DB.
       */
      isRemote?: boolean
    } = {}
  ): Promise<Message[]> {
    try {
      const { limit = 50, before, after, signal } = options

      debug.log(`Core: Loading messages for channel: ${channelId}`, { limit, before, after })

      let isRemoteChannel = options.isRemote

      if (isRemoteChannel === undefined) {
        const { data: channel } = await supabase
          .from('channels')
          .select('id, is_remote, server_id')
          .eq('id', channelId)
          .maybeSingle()

        // Remote channel detection: is_remote flag, else check the server row
        isRemoteChannel = channel?.is_remote === true

        if (!isRemoteChannel && channel?.server_id) {
          const { data: server } = await supabase
            .from('servers')
            .select('is_local_server')
            .eq('id', channel.server_id)
            .maybeSingle()

          isRemoteChannel = server?.is_local_server === false
        }
      }

      if (isRemoteChannel) {
        debug.log(`Channel ${channelId} is remote, fetching via federation backend`)
        return await this.loadRemoteChannelMessages(channelId, options)
      }

      if (signal?.aborted) {
        throw this.createError('ABORTED', 'Request was aborted')
      }

      // Fast path: messages + reactions in a single round trip. The RPC does
      // not support the `after` param (only used by realtime catch-up), so
      // those calls keep the legacy path.
      if (!after) {
        const page = await this.tryLoadMessagePage({ channelId, limit, before })
        if (page) {
          const orderedMessages = page.messages
          if (orderedMessages.length > 0) {
            orderedMessages.forEach((message: any) => {
              message.reactions = page.reactionsByMessage[message.id] || []
            })
            await this.populateReactionsStoreCache(page.reactionsByMessage)
          }

          debug.log(`Core: Loaded ${orderedMessages.length} messages with reactions (single round trip) for channel: ${channelId}`)

          const { processMessageDecryption } = await import('@/utils/messageDecryption')
          return await processMessageDecryption(orderedMessages)
        }
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

      debug.log('Executing message load query...')
      const { data: messages, error } = await query

      if (error) {
        debug.error('Failed to load messages:', error)
        throw this.createError('LOAD_MESSAGES_FAILED', error.message, error)
      }

      const messageList = messages || []
      debug.log(`Loaded ${messageList.length} messages from database for channel ${channelId}`)
      
      // Reverse to get oldest-first for display (since query returns newest-first)
      const orderedMessages = messageList.reverse()

      if (orderedMessages.length > 0) {
        const messageIds = orderedMessages.map(m => m.id)
        const reactionsByMessage = await this.getBatchMessageReactions(messageIds)
        
        orderedMessages.forEach(message => {
          message.reactions = reactionsByMessage[message.id] || []
        })
        
        // Feeds reactionsStore so getMessageReactions() works unchanged
        await this.populateReactionsStoreCache(reactionsByMessage)
      }

      debug.log(`Core: Loaded ${orderedMessages.length} messages with reactions for channel: ${channelId}`)
      
      const { processMessageDecryption } = await import('@/utils/messageDecryption')
      const decryptedMessages = await processMessageDecryption(orderedMessages)
      
      return decryptedMessages
    } catch (error) {
      debug.error('Core: Failed to load channel messages:', error)
      throw error
    }
  }

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

    // Prefer local DB first - AP federation inserts messages with proper structured
    // content (preserving custom emojis, etc.). The remote API re-parses HTML and
    // loses that structure. Only fall back to remote fetch if local DB is empty.
    const localMessages = await this.loadCachedRemoteMessages(channelId, options)
    if (localMessages.length > 0) {
      debug.log(`Using ${localMessages.length} locally-synced messages for remote channel (AP federation)`)

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

    try {
      const params = new URLSearchParams()
      params.append('limit', String(limit))
      if (before) params.append('before', before)

      // The federation backend proxies to the remote instance, so latency is
      // unbounded - a slow/dead remote must not hang the channel open forever.
      // AbortSignal.any is missing from the TS lib in use; feature-detect it.
      const timeoutSignal = AbortSignal.timeout(10000)
      const abortSignalAny: ((signals: AbortSignal[]) => AbortSignal) | undefined = (AbortSignal as any).any
      const signal = options.signal && abortSignalAny
        ? abortSignalAny([options.signal, timeoutSignal])
        : timeoutSignal

      const response = await fetch(apiUrl(`/api/federation/channels/${channelId}/messages?${params}`), {
        headers: {
          'Accept': 'application/json',
        },
        signal,
      })

      if (!response.ok) {
        debug.warn(`Failed to fetch remote messages: ${response.status}`)
        return []
      }

      const data = await response.json()
      const remoteMessages = data.messages || []

      debug.log(`Fetched ${remoteMessages.length} messages from remote channel (source: ${data.source})`)

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

      const orderedMessages = messages.reverse()

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
      debug.error('Failed to fetch remote channel messages:', error)
      return []
    }
  }

  private async loadCachedRemoteMessages(
    channelId: string,
    options: { limit?: number; before?: string } = {}
  ): Promise<Message[]> {
    const { limit = 50, before } = options

    // Same as local channel load: thread replies must not appear in the main feed
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

    const { data: messages } = await query
    debug.log(`Loaded ${(messages || []).length} cached messages for remote channel (non-thread only)`)
    
    return (messages || []).reverse()
  }

  /**
   * Parse remote message content (ActivityPub HTML to our format)
   * Preserves custom emojis as images and converts common HTML to our format
   */
  private parseRemoteContent(content: string | any[]): any[] {
    if (Array.isArray(content)) {
      return content
    }

    if (!content) {
      debug.log('parseRemoteContent received null/undefined content')
      return [{ type: 'text', text: '' }]
    }

    if (typeof content === 'string') {
      if (content.includes('<img') || content.includes('emoji')) {
        debug.log('parseRemoteContent input (first 300 chars):', content.substring(0, 300))
      }
      const result: any[] = []
      
      let processedContent = content
      
      processedContent = processedContent.replace(/<br\s*\/?>/gi, '\n')
      
      processedContent = processedContent.replace(/<\/p>\s*<p>/gi, '\n\n')
      processedContent = processedContent.replace(/<\/?p>/gi, '')
      
      // Matches emoji img tags across formats (class="emoji", title/alt/data-emoji attrs).
      const imgRegex = /<img\s+([^>]*)>/gi
      
      processedContent = processedContent.replace(imgRegex, (match, attrs) => {
        const srcMatch = attrs.match(/src=["']([^"']+)["']/i)
        if (!srcMatch) return match // Not a valid image, keep as-is
        
        const src = srcMatch[1]
        
        // Check if it's likely an emoji (has emoji class, or emoji in URL, or custom-emoji in URL)
        const isEmoji = /class=["'][^"']*emoji/i.test(attrs) ||
                       /emoji|custom[-_]?emoji/i.test(src) ||
                       /\/emojis?\//i.test(src) ||
                       /alt=["']:?[a-zA-Z0-9_-]+:?["']/i.test(attrs)
        
        if (!isEmoji) return match // Not an emoji, keep as-is
        
        const altMatch = attrs.match(/alt=["']:?([^"':]+):?["']/i)
        const titleMatch = attrs.match(/title=["']:?([^"':]+):?["']/i)
        const dataMatch = attrs.match(/data-(?:emoji|shortcode)=["']([^"']+)["']/i)
        
        const emojiName = (altMatch?.[1] || titleMatch?.[1] || dataMatch?.[1] || 'emoji').trim()
        
        return `[REMOTE_EMOJI:${emojiName}:${src}]`
      })
      
      // Also handle Misskey/Mastodon style emoji: <span class="emoji">:name:</span>
      processedContent = processedContent.replace(/<span[^>]*class="[^"]*emoji[^"]*"[^>]*>([^<]+)<\/span>/gi, (match, emojiCode) => {
        return emojiCode // Keep the :emoji_name: text for now
      })
      
      const text = processedContent.replace(/<[^>]*>/g, '').trim()
      
      if (text.includes('[REMOTE_EMOJI:')) {
        // Split while keeping the delimiter
        const parts = text.split(/(\[REMOTE_EMOJI:[^\]]+\])/g)
        for (const part of parts) {
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

      debug.log(`Core: Loading messages for conversation: ${conversationId}`)

      if (signal?.aborted) {
        throw this.createError('ABORTED', 'Request was aborted')
      }

      // Fast path: messages + reactions in a single round trip (see
      // loadChannelMessages). `after` is only used by realtime catch-up and
      // keeps the legacy path.
      if (!after) {
        const page = await this.tryLoadMessagePage({ conversationId, limit, before })
        if (page) {
          const orderedMessages = page.messages
          if (orderedMessages.length > 0) {
            orderedMessages.forEach((message: any) => {
              message.reactions = page.reactionsByMessage[message.id] || []
            })
            await this.populateReactionsStoreCache(page.reactionsByMessage)
          }

          debug.log(`Core: Loaded ${orderedMessages.length} messages with reactions (single round trip) for conversation: ${conversationId}`)

          const { processMessageDecryption } = await import('@/utils/messageDecryption')
          return await processMessageDecryption(orderedMessages)
        }
      }

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

      if (orderedMessages.length > 0) {
        const messageIds = orderedMessages.map(m => m.id)
        const reactionsByMessage = await this.getBatchMessageReactions(messageIds)
        
        orderedMessages.forEach(message => {
          message.reactions = reactionsByMessage[message.id] || []
        })
        
        // Feeds reactionsStore so getMessageReactions() works unchanged  
        await this.populateReactionsStoreCache(reactionsByMessage)
      }

      debug.log(`Core: Loaded ${orderedMessages.length} messages with reactions for conversation: ${conversationId}`)
      
      const { processMessageDecryption } = await import('@/utils/messageDecryption')
      const decryptedMessages = await processMessageDecryption(orderedMessages)
      
      return decryptedMessages
    } catch (error) {
      debug.error('Core: Failed to load conversation messages:', error)
      throw error
    }
  }

  async loadMessage(messageId: string): Promise<Message | null> {
    try {
      debug.log(`Core: Loading message: ${messageId}`)

      const { data: message, error } = await supabase
        .from('messages')
        .select('*')
        .eq('id', messageId)
        .single()

      if (error) {
        if (error.code === 'PGRST116') {
          debug.log(`ℹCore: Message not found: ${messageId}`)
          return null
        }
        throw this.createError('LOAD_MESSAGE_FAILED', error.message, error)
      }

      debug.log(`Core: Loaded message: ${messageId}`)
      return message
    } catch (error) {
      debug.error('Core: Failed to load message:', error)
      throw error
    }
  }

  private async getCurrentUserProfileId(): Promise<string> {
    try {
      return await authContextService.getCurrentProfileId()
    } catch (error) {
      debug.error('Core: Failed to get current user profile ID:', error)
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
      const userId = await this.getCurrentUserProfileId()
      
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

  /**
   * Tag a message's metadata so we can audit that the user explicitly chose
   * to send plaintext into an encryption-intended room. This shows up in
   * `messages.metadata.plaintext_override` for moderation/audit/UI badges.
   */
  private markPlaintextOverride(meta: Record<string, any>, reason: string): void {
    meta.plaintext_override = {
      authorized: true,
      reason,
      at: new Date().toISOString(),
    }
  }
}

export const coreMessageService = CoreMessageService.getInstance()