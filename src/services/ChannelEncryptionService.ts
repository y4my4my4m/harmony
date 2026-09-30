/** Reads and writes per-channel encryption through effective_channel_encryption / set_channel_encryption. */
import { supabase } from '@/supabase'
import {
  parseEffectiveChannelEncryption,
  type EffectiveChannelEncryption,
  type HistoryVisibility,
} from '@/utils/channelEncryption'

export interface ChannelEncryptionChange {
  messagesEncrypted?: boolean
  voiceEncrypted?: boolean
  historyVisibility?: HistoryVisibility
}

/**
 * The channel's effective state, or null when the caller cannot see the channel. Throws on a
 * transport or database error so callers fail closed.
 */
export async function fetchEffectiveChannelEncryption(channelId: string): Promise<EffectiveChannelEncryption | null> {
  const { data, error } = await supabase.rpc('effective_channel_encryption', { p_channel_id: channelId })
  if (error) throw error
  return parseEffectiveChannelEncryption(data)
}

/** Omitted fields are left unchanged. Returns the effective state after the change. */
export async function setChannelEncryption(
  channelId: string,
  change: ChannelEncryptionChange,
): Promise<EffectiveChannelEncryption | null> {
  const { data, error } = await supabase.rpc('set_channel_encryption', {
    p_channel_id: channelId,
    p_messages_encrypted: change.messagesEncrypted ?? null,
    p_voice_encrypted: change.voiceEncrypted ?? null,
    p_history_visibility: change.historyVisibility ?? null,
  })
  if (error) throw error
  return parseEffectiveChannelEncryption(data)
}
