/**
 * Per-icon rail selectors. Each icon owns small computeds over shared indexes,
 * so an unread or notification change re-renders only the icons whose values
 * change; the rail itself depends on order alone.
 */

import { computed, inject, provide, ref, type ComputedRef, type InjectionKey, type Ref } from 'vue'
import { serverUnreadTotals } from '@/composables/useUnreadCounts'
import { useNotificationStore } from '@/stores/useNotification'
import type { Server } from '@/types'

export interface RailContext {
  activeServerId: Readonly<Ref<string | null>>
}

const RAIL_CONTEXT: InjectionKey<RailContext> = Symbol('server-rail')

export function provideRailContext(ctx: RailContext): void {
  provide(RAIL_CONTEXT, ctx)
}

const fallbackContext: RailContext = { activeServerId: ref(null) }

/** Minute clock for timed mutes. Ticks only while a rail is mounted. */
const nowMinute = ref(Date.now())
let clockUsers = 0
let clockTimer: ReturnType<typeof setInterval> | null = null

export function retainRailClock(): () => void {
  clockUsers++
  if (!clockTimer) clockTimer = setInterval(() => { nowMinute.value = Date.now() }, 60_000)
  return () => {
    clockUsers--
    if (clockUsers <= 0 && clockTimer) {
      clearInterval(clockTimer)
      clockTimer = null
      clockUsers = 0
    }
  }
}

export function isMutedAt(server: Pick<Server, 'muted' | 'muted_until'>, now: number): boolean {
  if (!server.muted) return false
  if (!server.muted_until) return true
  return Date.parse(server.muted_until) > now
}

export function isServerMuted(server: Pick<Server, 'muted' | 'muted_until'>): boolean {
  return isMutedAt(server, nowMinute.value)
}

export interface RailServerState {
  selected: ComputedRef<boolean>
  mentions: ComputedRef<number>
  hasUnread: ComputedRef<boolean>
  muted: ComputedRef<boolean>
}

export function useRailServerState(server: () => Server): RailServerState {
  const ctx = inject(RAIL_CONTEXT, fallbackContext)
  const notifications = useNotificationStore()
  const selected = computed(() => ctx.activeServerId.value === server().id)
  const mentions = computed(() => notifications.notificationCounts?.unreadServerMentions?.get(server().id) ?? 0)
  const muted = computed(() => isServerMuted(server()))
  const hasUnread = computed(() => {
    if (mentions.value > 0) return true
    if (muted.value) return false
    return (serverUnreadTotals.value.get(server().id)?.messages ?? 0) > 0
  })
  return { selected, mentions, hasUnread, muted }
}

/** Folder aggregate: any member mention, and any unmuted member unread. */
export function useRailFolderState(servers: () => readonly Server[]) {
  const notifications = useNotificationStore()
  const mentions = computed(() => {
    const map = notifications.notificationCounts?.unreadServerMentions
    if (!map) return 0
    let n = 0
    for (const s of servers()) n += map.get(s.id) ?? 0
    return n
  })
  const hasUnread = computed(() => {
    if (mentions.value > 0) return true
    const totals = serverUnreadTotals.value
    return servers().some(s => !isServerMuted(s) && (totals.get(s.id)?.messages ?? 0) > 0)
  })
  return { mentions, hasUnread }
}

export function useRailContext(): RailContext {
  return inject(RAIL_CONTEXT, fallbackContext)
}
