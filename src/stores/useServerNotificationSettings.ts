import { defineStore } from 'pinia'
import { useToast } from 'vue-toastification'
import { i18n } from '@/i18n'
import { debug } from '@/utils/debug'
import { userEventChannel } from '@/services/UserEventChannel'
import { useServerChannelStore } from '@/stores/useServerChannel'
import {
  channelMuted,
  effectiveLevel,
  findOverride,
  getServerNotificationSettings,
  updateNotificationOverride,
  updateServerNotificationSettings,
  type NotificationLevel,
  type OverrideChanges,
  type OverrideTarget,
  type ServerNotificationSettings,
  type ServerSettingsChanges,
} from '@/services/notificationSettings'

/**
 * The signed-in member's notification settings per server. Every write returns the server's
 * full state, which replaces the cached copy; notification_settings:changed refetches it on
 * other devices.
 */

const pendingLoads = new Map<string, Promise<ServerNotificationSettings | null>>()
// Writes to one server run in order; only the last one's state is applied, so an earlier
// response never undoes a later control's change on screen.
const writeTails = new Map<string, Promise<unknown>>()
const writeSeq = new Map<string, number>()
let unsubscribeChanged: (() => void) | null = null

export const useServerNotificationSettingsStore = defineStore('serverNotificationSettings', {
  state: () => ({
    byServer: {} as Record<string, ServerNotificationSettings>,
    modalServerId: null as string | null,
    /** Writes in flight. */
    saving: 0,
  }),

  getters: {
    settingsFor: (state) => (serverId: string | null | undefined): ServerNotificationSettings | null =>
      (serverId && state.byServer[serverId]) || null,

    /** Channel or category mute; null categoryId for a channel outside any category. */
    isChannelMuted: (state) =>
      (serverId: string | null | undefined, channelId: string, categoryId: string | null | undefined): boolean =>
        !!serverId && channelMuted(state.byServer[serverId], channelId, categoryId),

    channelLevel: (state) =>
      (serverId: string | null | undefined, channelId: string, categoryId: string | null | undefined): NotificationLevel | null => {
        const settings = serverId ? state.byServer[serverId] : undefined
        return settings ? effectiveLevel(settings, channelId, categoryId) : null
      },
  },

  actions: {
    async load(serverId: string, force = false): Promise<ServerNotificationSettings | null> {
      this.listen()
      if (!force && this.byServer[serverId]) return this.byServer[serverId]
      const pending = pendingLoads.get(serverId)
      if (pending) return pending

      const request = (async () => {
        try {
          const settings = await getServerNotificationSettings(serverId)
          this.apply(settings)
          return settings
        } catch (error) {
          debug.warn('Notification settings unavailable:', error)
          return null
        } finally {
          pendingLoads.delete(serverId)
        }
      })()
      pendingLoads.set(serverId, request)
      return request
    },

    /** Caches a server's state and mirrors its mute onto the rail's server row. */
    apply(settings: ServerNotificationSettings): void {
      if (!settings.server_id) return
      this.byServer[settings.server_id] = settings
      const server = useServerChannelStore().servers.find((s) => s.id === settings.server_id)
      if (server) {
        server.muted = settings.muted
        server.muted_until = settings.muted_until
      }
    },

    listen(): void {
      if (unsubscribeChanged) return
      unsubscribeChanged = userEventChannel.on('notification_settings:changed', (payload) => {
        const serverId = typeof payload.server_id === 'string' ? payload.server_id : null
        const store = useServerNotificationSettingsStore()
        if (serverId && store.byServer[serverId]) void store.load(serverId, true)
      })
    },

    openModal(serverId: string): void {
      this.modalServerId = serverId
      void this.load(serverId, true)
    },

    closeModal(): void {
      this.modalServerId = null
    },

    /** before: the state to restore when the write fails and no later write follows it. */
    async run(
      serverId: string,
      before: ServerNotificationSettings | undefined,
      write: () => Promise<ServerNotificationSettings>,
    ): Promise<boolean> {
      const seq = (writeSeq.get(serverId) ?? 0) + 1
      writeSeq.set(serverId, seq)
      const task = (writeTails.get(serverId) ?? Promise.resolve()).catch(() => {}).then(write)
      writeTails.set(serverId, task)
      this.saving++
      try {
        const settings = await task
        if (writeSeq.get(serverId) === seq) this.apply(settings)
        return true
      } catch (error) {
        debug.error('Failed to save notification settings:', error)
        if (before && writeSeq.get(serverId) === seq) this.apply(before)
        useToast().error(i18n.global.t('notificationSettings.saveFailed'))
        return false
      } finally {
        this.saving--
        if (writeTails.get(serverId) === task) writeTails.delete(serverId)
      }
    },

    /** Patches the cached state before the write lands; a failed write restores it. */
    async updateServer(serverId: string, changes: ServerSettingsChanges): Promise<boolean> {
      const current = this.byServer[serverId]
      if (current) {
        this.byServer[serverId] = {
          ...current,
          ...changes,
          ...('muted' in changes ? { muted_until: changes.muted ? changes.muted_until ?? null : null } : {}),
        } as ServerNotificationSettings
      }
      return this.run(serverId, current, () => updateServerNotificationSettings(serverId, changes))
    },

    /** until: an ISO end time, null for an open-ended mute, false to unmute. */
    setServerMute(serverId: string, until: string | null | false): Promise<boolean> {
      return this.updateServer(
        serverId,
        until === false ? { muted: false } : { muted: true, muted_until: until },
      )
    },

    async updateOverride(serverId: string, target: OverrideTarget, changes: OverrideChanges): Promise<boolean> {
      const current = this.byServer[serverId]
      if (current) {
        const existing = findOverride(current, target)
        const next = {
          channel_id: 'channelId' in target ? target.channelId : null,
          category_id: 'categoryId' in target ? target.categoryId : null,
          level: existing?.level ?? null,
          muted: existing?.muted ?? false,
          muted_until: existing?.muted_until ?? null,
          ...changes,
        }
        if ('muted' in changes && !changes.muted) next.muted_until = null
        const others = current.overrides.filter((o) => o !== existing)
        this.byServer[serverId] = {
          ...current,
          overrides: next.level || next.muted ? [...others, next] : others,
        }
      }
      return this.run(serverId, current, () => updateNotificationOverride(target, changes))
    },

    removeOverride(serverId: string, target: OverrideTarget): Promise<boolean> {
      return this.updateOverride(serverId, target, { level: null, muted: false })
    },
  },
})
