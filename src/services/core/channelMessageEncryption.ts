/**
 * Send-side encryption for channel and thread messages.
 *
 * A channel is encrypted or it is not; there is no plaintext fallback inside an encrypted
 * channel, and enforce_channel_message_encryption() rejects plaintext there. Failures raise
 * ENCRYPTION_REQUIRED with a reason the UI turns into a setup or unlock prompt.
 */
import { supabase } from '@/supabase'
import type { MessagePart } from '@/types'
import { debug } from '@/utils/debug'
import { withPlaintextMentions } from '@/utils/channelEncryption'
import {
  cachedEffectiveChannelEncryption,
  fetchEffectiveChannelEncryption,
  forgetChannelEncryption,
} from '@/services/ChannelEncryptionService'
import { mediaRoom, messageMediaPathsIn } from '@/services/privateMedia'

/**
 *   setup        the sender has no encryption keys
 *   unlock       the sender's keys are locked
 *   failed       encryption threw
 *   unavailable  the channel state could not be read
 *   changed      the database rejected plaintext: the channel was encrypted after the check
 */
export type ChannelEncryptionFailure = 'setup' | 'unlock' | 'failed' | 'unavailable' | 'changed'

export interface ChannelEncryptionError {
  code: 'ENCRYPTION_REQUIRED'
  reason: ChannelEncryptionFailure
  message: string
  details?: unknown
}

const FAILURE_MESSAGES: Record<ChannelEncryptionFailure, string> = {
  setup: 'This channel is end-to-end encrypted. Set up encryption to send messages here.',
  unlock: 'This channel is end-to-end encrypted. Unlock encryption with your recovery key to send messages here.',
  failed: 'Encryption failed, so the message was not sent.',
  unavailable: 'Could not check whether this channel is encrypted, so the message was not sent.',
  changed: 'This channel is now end-to-end encrypted. Send the message again to encrypt it.',
}

export function channelEncryptionError(reason: ChannelEncryptionFailure, details?: unknown): ChannelEncryptionError {
  return { code: 'ENCRYPTION_REQUIRED', reason, message: FAILURE_MESSAGES[reason], details }
}

export function isChannelEncryptionError(error: unknown): error is ChannelEncryptionError {
  const e = error as ChannelEncryptionError | null
  return !!e && e.code === 'ENCRYPTION_REQUIRED' && typeof e.reason === 'string'
}

let megolmEncryptionService: any = null

/** The Megolm service, imported on first use and initialized for the signed-in user. */
export async function getEncryptionService(): Promise<any> {
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
        await megolmEncryptionService.initialize(session.user.id)
      }
    } catch (error) {
      debug.warn('Failed to lazy-initialize encryption:', error)
    }
  }
  return megolmEncryptionService
}

/**
 * Whether the channel's messages must be encrypted, from the last read of the channel's state
 * unless `fresh`. Throws ENCRYPTION_REQUIRED/unavailable on lookup failure.
 */
export async function channelRequiresEncryption(
  channelId: string,
  options: { fresh?: boolean } = {},
): Promise<boolean> {
  try {
    const state = options.fresh
      ? await fetchEffectiveChannelEncryption(channelId)
      : await cachedEffectiveChannelEncryption(channelId)
    return state?.messagesEncrypted === true
  } catch (error) {
    throw channelEncryptionError('unavailable', error)
  }
}

/** The database refused plaintext: enforce_channel_message_encryption() found the channel encrypted. */
export function isChannelEncryptedRefusal(error: { message?: string } | null | undefined): boolean {
  return (error?.message || '').includes('CHANNEL_ENCRYPTED')
}

/**
 * The payload for a second insert after the database refused a plaintext one: the channel's
 * state is read again and the content encrypted. When the channel still reads as plaintext or
 * the sender cannot encrypt, throws the 'changed' refusal with the database error.
 */
export async function encryptAfterPlaintextRefusal(
  params: Parameters<typeof encryptChannelContent>[0],
  refusal: unknown,
): Promise<EncryptedChannelPayload> {
  forgetChannelEncryption(params.channelId)
  const encrypted = await channelRequiresEncryption(params.channelId).catch(() => false)
  if (!encrypted) throw channelEncryptionError('changed', refusal)
  try {
    return await encryptChannelContent(params)
  } catch {
    throw channelEncryptionError('changed', refusal)
  }
}

export interface EncryptedChannelPayload {
  content: MessagePart[]
  encryption_metadata: any
  /** messages.media_paths: the message_media objects the plaintext names. */
  media_paths: string[]
}

/**
 * Encrypts `content` for the channel's Megolm room and appends its mention parts in plaintext.
 * Recipients are the server's members. Threads share the parent channel's room.
 */
export async function encryptChannelContent(params: {
  serverId: string | null
  channelId: string
  senderId: string
  content: MessagePart[]
}): Promise<EncryptedChannelPayload> {
  const service = await getEncryptionService()
  if (!service || !service.isInitialized()) {
    throw channelEncryptionError('setup')
  }
  // The member read does not depend on the key checks; it runs beside them.
  const members = params.serverId
    ? Promise.resolve(supabase.from('user_servers').select('user_id').eq('server_id', params.serverId))
    : Promise.resolve({ data: [] as Array<{ user_id: string }> })
  members.catch(() => {})
  if (!(await service.hasRecoveryKey())) {
    throw channelEncryptionError('setup')
  }
  if (!service.isUnlocked()) {
    throw channelEncryptionError('unlock')
  }

  try {
    const { data: memberRows } = await members
    const recipientIds: string[] = memberRows?.map((m: { user_id: string }) => m.user_id) || []
    if (!recipientIds.includes(params.senderId)) recipientIds.push(params.senderId)

    const encrypted = await service.encryptMessage(params.content, params.channelId, recipientIds)
    return {
      content: withPlaintextMentions(encrypted.content, params.content),
      encryption_metadata: encrypted.encryption_metadata,
      media_paths: messageMediaPathsIn(params.content, mediaRoom({ channelId: params.channelId })),
    }
  } catch (error) {
    debug.error('Channel encryption failed:', error)
    throw channelEncryptionError('failed', error)
  }
}
