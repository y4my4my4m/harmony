/**
 * Whether a call room is end-to-end encrypted, and the key setup or unlock prompt for a device
 * that cannot take part.
 *
 *   {channelId}            effective_channel_encryption().voice_encrypted
 *   dm-{conversationId}    conversation_encryption_settings.encryption_enabled, read fresh so the
 *                          caller and every callee answer from the same row
 *   anything else          never: a federated DM call (federated-dm-…) or a token join reaches a
 *                          participant whose instance holds no Megolm session for the room
 *
 * The prompt is EncryptionActionHost's: RecoveryKeySetupWizard for 'setup', KeyRecoveryModal for
 * 'unlock'.
 */
import { fetchEffectiveChannelEncryption } from '@/services/ChannelEncryptionService'
import { fetchConversationEncryption } from '@/services/conversationEncryption'
import { voiceE2EEService, type VoiceE2EEBlocker } from '@/services/encryption/VoiceE2EEService'
import { ENCRYPTION_ACTION_EVENT, type EncryptionActionDetail } from '@/composables/useEncryptionAction'
import { localDMCallConversationId } from '@/utils/callRooms'

export type CallEncryptionScope = 'channel' | 'dm'

const BLOCKED_MESSAGE_KEYS: Record<CallEncryptionScope, Record<VoiceE2EEBlocker, string>> = {
  channel: { setup: 'channelEncryption.voiceJoin.setup', unlock: 'channelEncryption.voiceJoin.unlock' },
  dm: { setup: 'channelEncryption.voiceJoin.dmSetup', unlock: 'channelEncryption.voiceJoin.dmUnlock' },
}

/** serverId is 'dm' for DM calls. Throws when the channel state cannot be read. */
export async function callRequiresE2EE(serverId: string, roomId: string): Promise<boolean> {
  if (!serverId || !roomId) return false
  if (serverId === 'dm') {
    const conversationId = localDMCallConversationId(roomId)
    return conversationId ? fetchConversationEncryption(conversationId) : false
  }
  const state = await fetchEffectiveChannelEncryption(roomId)
  return state?.voiceEncrypted === true
}

/**
 * Opens the setup or unlock prompt and returns its message. `toast: false` leaves showing the
 * message to the caller.
 */
export async function promptCallEncryptionSetup(
  blocker: VoiceE2EEBlocker,
  scope: CallEncryptionScope,
  options: { toast?: boolean } = {},
): Promise<string> {
  const { i18n } = await import('@/i18n')
  const message = String(i18n.global.t(BLOCKED_MESSAGE_KEYS[scope][blocker]))
  if (typeof window !== 'undefined') {
    const detail: EncryptionActionDetail = { reason: blocker, message, toast: options.toast !== false }
    window.dispatchEvent(new CustomEvent(ENCRYPTION_ACTION_EVENT, { detail }))
  }
  return message
}

/**
 * False after prompting when the room's calls are encrypted and this device cannot take part.
 * A device that can take part reads nothing. A read failure answers true; the join re-checks.
 */
export async function ensureCanJoinCall(serverId: string, roomId: string): Promise<boolean> {
  if (voiceE2EEService.canParticipate()) return true
  const required = await callRequiresE2EE(serverId, roomId).catch(() => false)
  if (!required) return true
  const blocker = await voiceE2EEService.participationBlocker()
  if (!blocker) return true
  await promptCallEncryptionSetup(blocker, serverId === 'dm' ? 'dm' : 'channel')
  return false
}
