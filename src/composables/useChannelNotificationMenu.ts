/**
 * A channel's notification entries in a menu: Mark as read, mute, notification level and
 * the server's notification settings, as one state over useServerNotificationSettingsStore.
 *
 *   const notif = useChannelNotificationMenu(() => props.channel, () => props.serverId)
 *   notif.setLevel('none'); notif.mute(muteUntil('h1')); notif.unmute()
 */

import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { useI18n } from 'vue-i18n'
import { useServerNotificationSettingsStore } from '@/stores/useServerNotificationSettings'
import { useNotificationStore } from '@/stores/useNotification'
import { findOverride, inheritedLevel, isMuteActive, type NotificationLevel } from '@/services/notificationSettings'
import { authContextService } from '@/services/AuthContextService'
import { markChannelRead } from '@/services/readState'
import { useAnnouncer } from '@/composables/useAnnouncer'
import { debug } from '@/utils/debug'
import type { Channel } from '@/types'

export interface LevelOption {
  /** null follows the category and the server. */
  value: NotificationLevel | null
  icon: string
  label: string
}

export function useChannelNotificationMenu(
  channelSource: MaybeRefOrGetter<Channel | null | undefined>,
  serverIdSource?: MaybeRefOrGetter<string | null | undefined>,
) {
  const { t, locale } = useI18n()
  const { polite } = useAnnouncer()
  const store = useServerNotificationSettingsStore()

  const channel = computed(() => toValue(channelSource) ?? null)
  const serverId = computed(() => toValue(serverIdSource) ?? channel.value?.server_id ?? null)
  const settings = computed(() => store.settingsFor(serverId.value))
  const ownOverride = computed(() =>
    channel.value?.id ? findOverride(settings.value, { channelId: channel.value.id }) : null,
  )
  const categoryMuted = computed(() => {
    const categoryId = channel.value?.category
    return !!categoryId && isMuteActive(findOverride(settings.value, { categoryId }))
  })
  const ownMuted = computed(() => isMuteActive(ownOverride.value))
  const isMuted = computed(() => ownMuted.value || categoryMuted.value)
  const muteLabelKey = computed(() => {
    if (ownMuted.value) return 'notificationSettings.header.unmuteChannel'
    if (categoryMuted.value) return 'notificationSettings.header.unmuteCategory'
    return 'notificationSettings.header.muteChannel'
  })
  /** "Muted until 11/4/26, 3:00 PM" for a timed mute of the channel itself; '' otherwise. */
  const mutedUntilLabel = computed(() => {
    const until = ownMuted.value ? ownOverride.value?.muted_until : null
    if (!until) return ''
    const time = new Date(until).toLocaleString(locale.value, { dateStyle: 'short', timeStyle: 'short' })
    return t('serverRail.mute.until', { time })
  })
  /** The channel's own level; null follows its category and the server. */
  const level = computed<NotificationLevel | null>(() => ownOverride.value?.level ?? null)
  const levelLabel = (value: NotificationLevel) => t(`notificationSettings.levels.${value}`)
  const levelOptions = computed((): LevelOption[] => {
    const inherited = settings.value ? inheritedLevel(settings.value, channel.value?.category) : 'mentions'
    return [
      { value: null, icon: 'bell', label: t('notificationSettings.header.default', { level: levelLabel(inherited) }) },
      { value: 'all', icon: 'bell', label: levelLabel('all') },
      { value: 'mentions', icon: 'at-sign', label: levelLabel('mentions') },
      { value: 'none', icon: 'bell-off', label: levelLabel('none') },
    ]
  })

  const load = () => {
    if (serverId.value) void store.load(serverId.value)
  }

  const announce = (key: string, params: Record<string, unknown> = {}) => {
    const name = channel.value?.name
    if (name) polite(t(key, { name, ...params }))
  }

  const setLevel = async (value: NotificationLevel | null) => {
    const id = channel.value?.id
    if (!id || !serverId.value) return
    const label = levelOptions.value.find((option) => option.value === value)?.label ?? ''
    if (await store.updateOverride(serverId.value, { channelId: id }, { level: value })) {
      announce('notificationSettings.header.levelSet', { level: label })
    }
  }

  /** until: an ISO end time, null until unmuted. */
  const mute = async (until: string | null) => {
    const id = channel.value?.id
    if (!id || !serverId.value) return
    if (await store.updateOverride(serverId.value, { channelId: id }, { muted: true, muted_until: until })) {
      announce('notificationSettings.header.muted')
    }
  }

  // A channel muted through its category unmutes the category, as Discord's menu does.
  const unmute = async () => {
    const current = channel.value
    if (!current?.id || !serverId.value) return
    const target = !ownMuted.value && categoryMuted.value && current.category
      ? { categoryId: current.category }
      : { channelId: current.id }
    if (await store.updateOverride(serverId.value, target, { muted: false })) {
      announce('notificationSettings.header.unmuted')
    }
  }

  const toggleMute = () => (isMuted.value ? unmute() : mute(null))

  const openSettings = () => {
    if (serverId.value) store.openModal(serverId.value)
  }

  // Clears the channel's unread counts and its notifications under every location path
  // NotificationFormatter stores them at.
  const markRead = async () => {
    const id = channel.value?.id
    if (!id) return
    try {
      const ctx = await authContextService.getCurrentContext()
      if (!ctx.isAuthenticated) return
      try {
        await markChannelRead(id)
      } catch (error) {
        debug.error('Failed to clear channel unread counts:', error)
        return
      }
      const notificationStore = useNotificationStore()
      const unread = notificationStore.notifications.filter(n =>
        !n.is_read && (
          n.data?.channel_id === id ||
          n.data?.message?.channel_id === id ||
          n.data?.location?.channel_id === id
        ),
      )
      if (unread.length > 0) await Promise.all(unread.map(n => notificationStore.markAsRead(n.id)))
    } catch (error) {
      debug.error('Failed to mark channel as read:', error)
    }
  }

  return {
    serverId,
    isMuted,
    ownMuted,
    categoryMuted,
    muteLabelKey,
    mutedUntilLabel,
    level,
    levelOptions,
    load,
    setLevel,
    mute,
    unmute,
    toggleMute,
    openSettings,
    markRead,
  }
}
