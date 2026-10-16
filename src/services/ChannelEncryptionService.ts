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

// Every read of effective_channel_encryption is kept per channel for the send path. A
// server-structure broadcast of either settings table drops the entries it touches. A stale
// plaintext answer costs one refused insert: enforce_channel_message_encryption() rejects
// plaintext with CHANNEL_ENCRYPTED and the sender re-reads. A stale encrypted answer
// encrypts into a plaintext channel; the TTL bounds it, refreshing behind the answer.
const EFFECTIVE_TTL_MS = 5 * 60_000

interface EffectiveEntry {
  state: EffectiveChannelEncryption
  at: number
}

const effectiveByChannel = new Map<string, EffectiveEntry>()
const effectiveReads = new Map<string, Promise<EffectiveChannelEncryption | null>>()
let broadcastListenerInstalled = false

function installBroadcastListener(): void {
  if (broadcastListenerInstalled || typeof window === 'undefined') return
  broadcastListenerInstalled = true
  window.addEventListener('server-structure:settings-change', (event: Event) => {
    const detail = (event as CustomEvent).detail as { table?: string; new?: Record<string, unknown> | null } | null
    if (detail?.table === 'channel_encryption_settings') {
      const channelId = detail.new?.channel_id
      forgetChannelEncryption(typeof channelId === 'string' ? channelId : null)
    } else if (detail?.table === 'server_encryption_settings') {
      const serverId = detail.new?.server_id
      forgetServerChannelEncryption(typeof serverId === 'string' ? serverId : null)
    }
  })
}

/** Reads still running when an entry is dropped do not write it back. */
function readEffective(channelId: string): Promise<EffectiveChannelEncryption | null> {
  const running = effectiveReads.get(channelId)
  if (running) return running
  installBroadcastListener()
  const read = (async () => {
    const { data, error } = await supabase.rpc('effective_channel_encryption', { p_channel_id: channelId })
    if (error) throw error
    return parseEffectiveChannelEncryption(data)
  })()
  effectiveReads.set(channelId, read)
  read.then(
    (state) => {
      if (effectiveReads.get(channelId) !== read) return
      effectiveReads.delete(channelId)
      if (state) effectiveByChannel.set(channelId, { state, at: Date.now() })
      else effectiveByChannel.delete(channelId)
    },
    () => {
      if (effectiveReads.get(channelId) === read) effectiveReads.delete(channelId)
    },
  )
  return read
}

/**
 * The channel's effective state, or null when the caller cannot see the channel. Throws on a
 * transport or database error so callers fail closed. Always asks the database; a read already
 * running for the channel is shared.
 */
export function fetchEffectiveChannelEncryption(channelId: string): Promise<EffectiveChannelEncryption | null> {
  return readEffective(channelId)
}

/** As fetchEffectiveChannelEncryption, answered from the last read when there is one. */
export async function cachedEffectiveChannelEncryption(channelId: string): Promise<EffectiveChannelEncryption | null> {
  const entry = effectiveByChannel.get(channelId)
  if (!entry) return readEffective(channelId)
  if (Date.now() - entry.at >= EFFECTIVE_TTL_MS) readEffective(channelId).catch(() => {})
  return entry.state
}

/** Drops the channel's entry, or every entry without an id. */
export function forgetChannelEncryption(channelId?: string | null): void {
  if (!channelId) {
    effectiveByChannel.clear()
    effectiveReads.clear()
    return
  }
  effectiveByChannel.delete(channelId)
  effectiveReads.delete(channelId)
}

/** Drops the entries of the server's channels; every entry without an id. */
export function forgetServerChannelEncryption(serverId?: string | null): void {
  if (!serverId) {
    forgetChannelEncryption()
    return
  }
  for (const [channelId, entry] of effectiveByChannel) {
    if (entry.state.serverId === serverId || !entry.state.serverId) effectiveByChannel.delete(channelId)
  }
  // A running read names no server until it settles.
  effectiveReads.clear()
}

/** Omitted fields are left unchanged. Returns the effective state after the change. */
export async function setChannelEncryption(
  channelId: string,
  change: ChannelEncryptionChange,
): Promise<EffectiveChannelEncryption | null> {
  effectiveReads.delete(channelId)
  effectiveByChannel.delete(channelId)
  const { data, error } = await supabase.rpc('set_channel_encryption', {
    p_channel_id: channelId,
    p_messages_encrypted: change.messagesEncrypted ?? null,
    p_voice_encrypted: change.voiceEncrypted ?? null,
    p_history_visibility: change.historyVisibility ?? null,
  })
  if (error) throw error
  const state = parseEffectiveChannelEncryption(data)
  // A read that overlapped the change may hold the state before it.
  effectiveReads.delete(channelId)
  if (state) effectiveByChannel.set(channelId, { state, at: Date.now() })
  return state
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
