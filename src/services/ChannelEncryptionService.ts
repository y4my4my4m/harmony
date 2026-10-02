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

// force_key_setup only drives the key-setup recommendation in the chat header.
// The server-structure broadcast invalidates the visible server's entry; the TTL
// bounds staleness for the others.
const FORCE_KEY_SETUP_TTL_MS = 60_000
const forceKeySetupByServer = new Map<string, { at: number; value: Promise<boolean> }>()

/** server_encryption_settings.force_key_setup, cached per server. False when unset or unreadable. */
export function fetchServerForceKeySetup(serverId: string): Promise<boolean> {
  const cached = forceKeySetupByServer.get(serverId)
  if (cached && Date.now() - cached.at < FORCE_KEY_SETUP_TTL_MS) return cached.value
  const value = Promise.resolve(
    supabase.from('server_encryption_settings').select('force_key_setup').eq('server_id', serverId).maybeSingle(),
  ).then(({ data, error }) => {
    if (error) {
      forceKeySetupByServer.delete(serverId)
      return false
    }
    return data?.force_key_setup === true
  }, (error) => {
    forceKeySetupByServer.delete(serverId)
    throw error
  })
  forceKeySetupByServer.set(serverId, { at: Date.now(), value })
  return value
}

export function invalidateServerForceKeySetup(serverId?: string | null): void {
  if (serverId) forceKeySetupByServer.delete(serverId)
  else forceKeySetupByServer.clear()
}
