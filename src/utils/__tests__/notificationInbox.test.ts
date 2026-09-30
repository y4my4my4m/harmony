import { describe, it, expect } from 'vitest'
import { badgeText, groupByDay, inTab, shortRelativeTime, unreadByTab } from '@/utils/notificationInbox'

const n = (id: string, type: string, created: Date, isRead = false) => ({
  id,
  type,
  is_read: isRead,
  created_at: created.toISOString(),
  data: {},
}) as any

const NOW = new Date(2026, 9, 1, 12, 0, 0)
const at = (daysAgo: number, hour = 9) => new Date(2026, 9, 1 - daysAgo, hour, 0, 0)

describe('inbox tabs', () => {
  it('puts replies and mentions under Mentions', () => {
    for (const type of ['mention', 'reply', 'thread_reply', 'activitypub_mention', 'activitypub_reply']) {
      expect(inTab('mentions', type)).toBe(true)
    }
    expect(inTab('mentions', 'dm')).toBe(false)
    expect(inTab('mentions', 'reaction')).toBe(false)
  })

  it('puts every federated type under Social', () => {
    expect(inTab('social', 'activitypub_follow')).toBe(true)
    expect(inTab('social', 'mention')).toBe(false)
    expect(inTab('all', 'anything')).toBe(true)
  })

  it('counts unread per tab', () => {
    const counts = unreadByTab([
      n('1', 'mention', NOW),
      n('2', 'activitypub_mention', NOW),
      n('3', 'activitypub_favorite', NOW),
      n('4', 'dm', NOW),
      n('5', 'mention', NOW, true),
    ])
    expect(counts).toEqual({ all: 4, mentions: 2, social: 2 })
  })
})

describe('groupByDay', () => {
  const labels = { today: 'Today', yesterday: 'Yesterday' }

  it('groups newest first under today, yesterday, weekday and date', () => {
    const groups = groupByDay([
      n('old', 'dm', at(30)),
      n('y', 'dm', at(1)),
      n('t2', 'dm', at(0, 8)),
      n('t1', 'dm', at(0, 11)),
      n('w', 'dm', at(3)),
    ], labels, NOW, 'en-US')

    expect(groups.map(g => g.label)).toEqual([
      'Today',
      'Yesterday',
      at(3).toLocaleDateString('en-US', { weekday: 'long' }),
      at(30).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }),
    ])
    expect(groups[0].items.map(i => i.id)).toEqual(['t1', 't2'])
  })

  it('adds the year for another year', () => {
    const lastYear = new Date(2025, 4, 2, 10)
    const [group] = groupByDay([n('a', 'dm', lastYear)], labels, NOW, 'en-US')
    expect(group.label).toContain('2025')
  })
})

describe('short times and badges', () => {
  it('formats compact relative times', () => {
    expect(shortRelativeTime(new Date(NOW.getTime() - 20_000).toISOString(), NOW)).toBe('now')
    expect(shortRelativeTime(new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW)).toBe('5m')
    expect(shortRelativeTime(new Date(NOW.getTime() - 3 * 3_600_000).toISOString(), NOW)).toBe('3h')
    expect(shortRelativeTime(new Date(NOW.getTime() - 2 * 86_400_000).toISOString(), NOW)).toBe('2d')
  })

  it('caps the badge at 99+', () => {
    expect(badgeText(7)).toBe('7')
    expect(badgeText(99)).toBe('99')
    expect(badgeText(100)).toBe('99+')
  })
})
