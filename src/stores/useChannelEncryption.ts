/**
 * Channel encryption state for the channel list, header and settings.
 *
 * Rows come from channel_encryption_settings and server_encryption_settings (members may read
 * both) and are resolved with resolveChannelEncryption. Broadcasts on server-structure:{id}
 * keep them current. This is display state; a send asks the database.
 */
import { defineStore } from 'pinia'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import {
  resolveChannelEncryption,
  type ChannelEncryptionRow,
  type EffectiveChannelEncryption,
  type ResolvedChannelEncryption,
  type ServerEncryptionPolicy,
} from '@/utils/channelEncryption'

interface SettingsBroadcast {
  table?: string
  new?: Record<string, any> | null
}

let listenerInstalled = false

export const useChannelEncryptionStore = defineStore('channelEncryption', {
  state: () => ({
    policies: {} as Record<string, ServerEncryptionPolicy>,
    rows: {} as Record<string, ChannelEncryptionRow>,
    channelServer: {} as Record<string, string>,
    loadedServers: {} as Record<string, true>,
  }),

  getters: {
    /** Null until the channel's server has loaded. */
    stateFor: (state) => (channelId: string | null | undefined): ResolvedChannelEncryption | null => {
      if (!channelId) return null
      const serverId = state.channelServer[channelId]
      if (!serverId || !state.loadedServers[serverId]) return null
      return resolveChannelEncryption(state.policies[serverId] ?? null, state.rows[channelId] ?? null)
    },
  },

  actions: {
    isMessagesEncrypted(channelId: string | null | undefined): boolean {
      return this.stateFor(channelId)?.messagesEncrypted === true
    },

    isVoiceEncrypted(channelId: string | null | undefined): boolean {
      return this.stateFor(channelId)?.voiceEncrypted === true
    },

    async loadServer(serverId: string, channelIds: string[]): Promise<void> {
      if (!serverId) return
      this.installListener()

      const [policyResult, rowsResult] = await Promise.all([
        supabase
          .from('server_encryption_settings')
          .select('encryption_mode, voice_encryption_mode')
          .eq('server_id', serverId)
          .maybeSingle(),
        channelIds.length > 0
          ? supabase
              .from('channel_encryption_settings')
              .select('channel_id, messages_encrypted, voice_encrypted, history_visibility, enabled_at, enabled_by')
              .in('channel_id', channelIds)
          : Promise.resolve({ data: [] as ChannelEncryptionRow[], error: null }),
      ])

      if (policyResult.error || rowsResult.error) {
        debug.warn('Failed to load channel encryption state:', policyResult.error || rowsResult.error)
        return
      }

      this.policies[serverId] = policyResult.data ?? {}
      for (const channelId of channelIds) {
        this.channelServer[channelId] = serverId
      }
      for (const row of (rowsResult.data ?? []) as ChannelEncryptionRow[]) {
        this.rows[row.channel_id] = row
      }
      this.loadedServers[serverId] = true
    },

    /**
     * Folds an effective_channel_encryption / set_channel_encryption result into the store. A
     * value the server floor fixes says nothing about the stored row, so it is not written.
     */
    applyEffective(effective: EffectiveChannelEncryption): void {
      if (effective.serverId) {
        this.channelServer[effective.channelId] = effective.serverId
        this.policies[effective.serverId] = {
          encryption_mode: effective.serverMode,
          voice_encryption_mode: effective.voiceMode,
        }
        this.loadedServers[effective.serverId] = true
      }
      const previous = this.rows[effective.channelId]
      this.rows[effective.channelId] = {
        channel_id: effective.channelId,
        messages_encrypted: effective.messagesLocked
          ? previous?.messages_encrypted ?? effective.messagesEncrypted
          : effective.messagesEncrypted,
        voice_encrypted: effective.voiceLocked
          ? previous?.voice_encrypted ?? effective.voiceEncrypted
          : effective.voiceEncrypted,
        history_visibility: effective.historyVisibility,
        enabled_at: effective.enabledAt,
        enabled_by: effective.enabledBy,
      }
    },

    applyBroadcast(detail: SettingsBroadcast | null | undefined): void {
      const row = detail?.new
      if (!row) return
      if (detail?.table === 'server_encryption_settings' && typeof row.server_id === 'string') {
        this.policies[row.server_id] = {
          encryption_mode: row.encryption_mode,
          voice_encryption_mode: row.voice_encryption_mode,
        }
      } else if (detail?.table === 'channel_encryption_settings' && typeof row.channel_id === 'string') {
        this.rows[row.channel_id] = row as ChannelEncryptionRow
      }
    },

    installListener(): void {
      if (listenerInstalled || typeof window === 'undefined') return
      listenerInstalled = true
      window.addEventListener('server-structure:settings-change', (event: Event) => {
        this.applyBroadcast((event as CustomEvent).detail)
      })
    },
  },
})
