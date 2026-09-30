/**
 * State and actions of the Today dashboard.
 *
 * One get_today_summary call per load. Refetches ride the per-user broadcast topic
 * (UserEventChannel): notification, unread, conversation and follow events schedule a
 * reload, at most one per MIN_INTERVAL_MS, deferred while the page is hidden. Voice rows
 * have no event on that topic; a POLL_MS interval covers them while the page is visible.
 *
 * The previous visit time is read once per mount and passed as p_since, so refreshes
 * within a visit keep the same window.
 */

import { onBeforeUnmount, onMounted, ref, shallowRef, type Ref } from 'vue'
import type { Router } from 'vue-router'
import { useToast } from 'vue-toastification'
import { useI18n } from 'vue-i18n'
import { todayDigestService } from '@/services/TodayDigestService'
import { userEventChannel } from '@/services/UserEventChannel'
import { announcementService } from '@/services/AnnouncementService'
import { interactionService } from '@/services/InteractionService'
import { useAnnouncementUnreadCount } from '@/composables/useAnnouncementUnreadCount'
import { userStorage } from '@/utils/userScopedStorage'
import { debug } from '@/utils/debug'
import {
  channelRoute,
  emptySummary,
  parseVisit,
  withMessages,
  withoutAnnouncement,
  withoutFollowRequest,
  withoutServer,
  type TodayFollower,
  type TodaySummary,
  type TodayVoiceChannel,
} from '@/utils/todaySummary'

const VISIT_KEY = 'today-last-visit'
const MIN_INTERVAL_MS = 5_000
const EVENT_DELAY_MS = 1_500
const POLL_MS = 60_000

export type TodayStatus = 'loading' | 'ready' | 'error'

export interface UseTodaySummary {
  summary: Ref<TodaySummary>
  status: Ref<TodayStatus>
  refreshing: Ref<boolean>
  refreshFailed: Ref<boolean>
  previousVisit: string | null
  reload: () => Promise<void>
  markServerRead: (serverId: string) => Promise<void>
  markAllChannelsRead: () => Promise<void>
  respondToFollowRequest: (follower: TodayFollower, accept: boolean) => Promise<void>
  dismissAnnouncement: (id: string) => Promise<void>
}

export function useTodaySummary(): UseTodaySummary {
  const toast = useToast()
  const { t } = useI18n()
  const announcementCount = useAnnouncementUnreadCount()

  const summary = shallowRef<TodaySummary>(emptySummary())
  const status = ref<TodayStatus>('loading')
  const refreshing = ref(false)
  const refreshFailed = ref(false)
  const previousVisit = parseVisit(userStorage.getItem(VISIT_KEY))

  let controller: AbortController | null = null
  let generation = 0
  let lastFetchAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let dueAt = 0
  let pendingWhileHidden = false
  let poll: ReturnType<typeof setInterval> | null = null
  const unsubscribers: Array<() => void> = []

  const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

  async function load(): Promise<void> {
    controller?.abort()
    const own = new AbortController()
    controller = own
    const gen = ++generation
    if (status.value !== 'ready') status.value = 'loading'
    refreshing.value = true
    lastFetchAt = Date.now()
    const started = performance.now()

    try {
      const result = await todayDigestService.getSummary(previousVisit, own.signal)
      if (gen !== generation) return
      summary.value = result ?? emptySummary()
      status.value = 'ready'
      refreshFailed.value = false
      debug.log(`Today: summary in ${Math.round(performance.now() - started)} ms`)
      void decrypt(gen)
    } catch (error) {
      if (gen !== generation || own.signal.aborted) return
      debug.error('Today: summary failed:', error)
      if (status.value === 'ready') refreshFailed.value = true
      else status.value = 'error'
    } finally {
      if (gen === generation) refreshing.value = false
    }
  }

  async function decrypt(gen: number): Promise<void> {
    const decrypted = await todayDigestService.decryptSummaryMessages(summary.value)
    if (gen !== generation || decrypted.length === 0) return
    summary.value = withMessages(summary.value, decrypted)
  }

  function schedule(delay: number): void {
    if (isHidden()) {
      pendingWhileHidden = true
      return
    }
    const at = Math.max(Date.now() + delay, lastFetchAt + MIN_INTERVAL_MS)
    if (timer && dueAt <= at) return
    if (timer) clearTimeout(timer)
    dueAt = at
    timer = setTimeout(() => {
      timer = null
      void load()
    }, at - Date.now())
  }

  function onVisibility(): void {
    if (!isHidden() && pendingWhileHidden) {
      pendingWhileHidden = false
      schedule(0)
    }
  }

  onMounted(() => {
    userStorage.setItem(VISIT_KEY, new Date().toISOString())
    void load()

    const onEvent = () => schedule(EVENT_DELAY_MS)
    unsubscribers.push(
      userEventChannel.on('notification:new', onEvent),
      userEventChannel.on('notification:bulk_read', onEvent),
      userEventChannel.on('unread:change', onEvent),
      userEventChannel.on('conversation:new', onEvent),
      userEventChannel.on('conversation:updated', onEvent),
      userEventChannel.on('follow:change', onEvent),
      userEventChannel.on('_reconnected', () => schedule(0)),
    )
    document.addEventListener('visibilitychange', onVisibility)
    poll = setInterval(() => schedule(0), POLL_MS)
  })

  onBeforeUnmount(() => {
    generation++
    controller?.abort()
    if (timer) clearTimeout(timer)
    if (poll) clearInterval(poll)
    document.removeEventListener('visibilitychange', onVisibility)
    for (const off of unsubscribers) off()
  })

  async function markServerRead(serverId: string): Promise<void> {
    const before = summary.value
    summary.value = withoutServer(before, serverId)
    try {
      await todayDigestService.markServerRead(serverId)
    } catch (error) {
      debug.error('Today: mark server read failed:', error)
      summary.value = before
      toast.error(t('today.errors.markRead'))
    }
    schedule(EVENT_DELAY_MS)
  }

  async function markAllChannelsRead(): Promise<void> {
    const before = summary.value
    const ids = before.servers.map(s => s.id)
    if (ids.length === 0) return
    summary.value = ids.reduce((s, id) => withoutServer(s, id), before)
    const results = await Promise.allSettled(ids.map(id => todayDigestService.markServerRead(id)))
    if (results.some(r => r.status === 'rejected')) {
      toast.error(t('today.errors.markRead'))
    }
    schedule(0)
  }

  async function respondToFollowRequest(follower: TodayFollower, accept: boolean): Promise<void> {
    const before = summary.value
    summary.value = withoutFollowRequest(before, follower.id)
    try {
      if (accept) await interactionService.acceptFollowRequest(follower.id)
      else await interactionService.rejectFollowRequest(follower.id)
    } catch (error) {
      debug.error('Today: follow request response failed:', error)
      summary.value = before
      toast.error(t('today.errors.followRequest'))
    }
  }

  async function dismissAnnouncement(id: string): Promise<void> {
    const before = summary.value
    summary.value = withoutAnnouncement(before, id)
    const ok = await announcementService.markAsRead(id)
    if (ok) {
      announcementCount.decrement()
    } else {
      summary.value = before
      toast.error(t('today.errors.announcement'))
    }
  }

  return {
    summary,
    status,
    refreshing,
    refreshFailed,
    previousVisit,
    reload: load,
    markServerRead,
    markAllChannelsRead,
    respondToFollowRequest,
    dismissAnnouncement,
  }
}

const waitFor = (test: () => boolean, timeoutMs: number): Promise<boolean> =>
  new Promise(resolve => {
    if (test()) return resolve(true)
    const started = Date.now()
    const tick = setInterval(() => {
      if (test()) {
        clearInterval(tick)
        resolve(true)
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(tick)
        resolve(false)
      }
    }, 100)
  })

/**
 * Opens a voice channel and joins it. joinVoiceChannel picks the local or federated path
 * from the current server, so the join waits until the route has made that server current.
 * Runs past the Today view's unmount.
 */
export async function joinVoiceFromToday(router: Router, voice: TodayVoiceChannel): Promise<boolean> {
  const [{ useServerChannelStore }, { useUnifiedVoiceChannelStore }, { useThemeStore }] = await Promise.all([
    import('@/stores/useServerChannel'),
    import('@/stores/unifiedVoiceChannel'),
    import('@/stores/useTheme'),
  ])
  const serverChannelStore = useServerChannelStore()
  const voiceStore = useUnifiedVoiceChannelStore()
  const themeStore = useThemeStore()

  await router.push(channelRoute(voice.server.id, voice.channelId))
  if (voiceStore.currentChannelId === voice.channelId) return true

  const ready = await waitFor(() => serverChannelStore.currentServer?.id === voice.server.id, 10_000)
  if (!ready) return false

  themeStore.playAudio('voice_connect')
  const joined = await voiceStore.joinVoiceChannel(voice.channelId, voice.server.id)
  if (!joined) themeStore.playAudio('voice_disconnect')
  return joined
}
