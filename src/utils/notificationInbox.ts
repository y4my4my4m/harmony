/**
 * Pure helpers for the notification inbox: tab membership, unread counts, day groups
 * and compact relative times.
 */

import type { Notification } from '@/types'

export type InboxTab = 'all' | 'mentions' | 'social'

export const INBOX_TABS: readonly InboxTab[] = ['all', 'mentions', 'social']

// Notifications that name the user or answer them.
const MENTION_TYPES = new Set([
  'mention',
  'reply',
  'thread_reply',
  'activitypub_mention',
  'activitypub_reply',
])

export function inTab(tab: InboxTab, type: string): boolean {
  if (tab === 'mentions') return MENTION_TYPES.has(type)
  if (tab === 'social') return type.startsWith('activitypub_')
  return true
}

export function unreadByTab(notifications: readonly Notification[]): Record<InboxTab, number> {
  const counts: Record<InboxTab, number> = { all: 0, mentions: 0, social: 0 }
  for (const n of notifications) {
    if (n.is_read) continue
    counts.all++
    if (MENTION_TYPES.has(n.type)) counts.mentions++
    if (n.type.startsWith('activitypub_')) counts.social++
  }
  return counts
}

export interface DayGroup {
  key: string
  label: string
  items: Notification[]
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

/**
 * Groups newest first by local calendar day. Labels: today, yesterday, the weekday
 * within the last week, then a date (with the year when it differs from now).
 */
export function groupByDay(
  notifications: readonly Notification[],
  labels: { today: string; yesterday: string },
  now: Date = new Date(),
  locale?: string,
): DayGroup[] {
  const sorted = [...notifications].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  )
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayMs = 24 * 60 * 60 * 1000
  const groups: DayGroup[] = []
  let current: DayGroup | null = null

  for (const n of sorted) {
    const created = new Date(n.created_at)
    const key = dayKey(created)
    if (!current || current.key !== key) {
      const startOfDay = new Date(created.getFullYear(), created.getMonth(), created.getDate()).getTime()
      const daysAgo = Math.round((startOfToday - startOfDay) / dayMs)
      let label: string
      if (daysAgo <= 0) label = labels.today
      else if (daysAgo === 1) label = labels.yesterday
      else if (daysAgo < 7) label = created.toLocaleDateString(locale, { weekday: 'long' })
      else if (created.getFullYear() === now.getFullYear()) {
        label = created.toLocaleDateString(locale, { month: 'long', day: 'numeric' })
      } else {
        label = created.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' })
      }
      current = { key, label, items: [] }
      groups.push(current)
    }
    current.items.push(n)
  }
  return groups
}

/** "now", "5m", "3h", "2d"; older than a week falls back to a short date. */
export function shortRelativeTime(iso: string, now: Date = new Date(), locale?: string): string {
  const created = new Date(iso)
  const minutes = Math.floor((now.getTime() - created.getTime()) / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return created.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

/** Badge text: counts above 99 read "99+". */
export function badgeText(count: number): string {
  return count > 99 ? '99+' : String(count)
}
