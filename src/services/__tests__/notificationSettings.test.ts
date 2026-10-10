/**
 * Client resolution of notification settings, which mirrors notification_policy():
 * channel > category > server setting > server default, and channel or category mutes.
 */

import { describe, expect, it } from 'vitest'
import {
  channelMuted,
  effectiveLevel,
  inheritedLevel,
  isMuteActive,
  muteUntil,
  normalizeSettings,
  type ServerNotificationSettings,
} from '@/services/notificationSettings'

const NOW = Date.parse('2026-10-10T12:00:00Z')

function settings(overrides: Partial<ServerNotificationSettings> = {}): ServerNotificationSettings {
  return normalizeSettings({
    server_id: 's1',
    muted: false,
    level: null,
    server_default: 'mentions',
    overrides: [],
    channels: [],
    categories: [],
    ...overrides,
  })
}

describe('effectiveLevel', () => {
  it('falls back to the server default, then the member setting', () => {
    expect(effectiveLevel(settings(), 'c1', 'k1')).toBe('mentions')
    expect(effectiveLevel(settings({ server_default: 'all' }), 'c1', 'k1')).toBe('all')
    expect(effectiveLevel(settings({ server_default: 'all', level: 'none' }), 'c1', 'k1')).toBe('none')
  })

  it('takes the category over the server and the channel over the category', () => {
    const s = settings({
      level: 'none',
      overrides: [
        { channel_id: null, category_id: 'k1', level: 'mentions', muted: false, muted_until: null },
        { channel_id: 'c1', category_id: null, level: 'all', muted: false, muted_until: null },
      ],
    })
    expect(effectiveLevel(s, 'c1', 'k1')).toBe('all')
    expect(effectiveLevel(s, 'c2', 'k1')).toBe('mentions')
    expect(effectiveLevel(s, 'c3', null)).toBe('none')
    expect(inheritedLevel(s, 'k1')).toBe('mentions')
  })

  it('skips an override that only mutes', () => {
    const s = settings({
      level: 'all',
      overrides: [{ channel_id: 'c1', category_id: null, level: null, muted: true, muted_until: null }],
    })
    expect(effectiveLevel(s, 'c1', null)).toBe('all')
  })
})

describe('channelMuted', () => {
  it('reads the channel and its category, not the server', () => {
    const s = settings({
      muted: true,
      overrides: [{ channel_id: null, category_id: 'k1', level: null, muted: true, muted_until: null }],
    })
    expect(channelMuted(s, 'c1', 'k1', NOW)).toBe(true)
    expect(channelMuted(s, 'c2', null, NOW)).toBe(false)
  })

  it('ends a mute at muted_until', () => {
    const s = settings({
      overrides: [{ channel_id: 'c1', category_id: null, level: null, muted: true, muted_until: '2026-10-10T12:30:00Z' }],
    })
    expect(channelMuted(s, 'c1', null, NOW)).toBe(true)
    expect(channelMuted(s, 'c1', null, NOW + 31 * 60_000)).toBe(false)
  })
})

describe('mute helpers', () => {
  it('turns a preset into an end time', () => {
    expect(muteUntil('h1', NOW)).toBe('2026-10-10T13:00:00.000Z')
    expect(muteUntil('forever', NOW)).toBeNull()
  })

  it('treats an open-ended mute as active', () => {
    expect(isMuteActive({ muted: true, muted_until: null }, NOW)).toBe(true)
    expect(isMuteActive({ muted: false, muted_until: null }, NOW)).toBe(false)
    expect(isMuteActive(null, NOW)).toBe(false)
  })
})

describe('normalizeSettings', () => {
  it('drops unknown levels and fills defaults', () => {
    const s = normalizeSettings({
      server_id: 's1',
      level: 'loud',
      server_default: null,
      push_notifications: null,
      overrides: [{ channel_id: 'c1', level: 'everything', muted: 'yes' }],
    })
    expect(s.level).toBeNull()
    expect(s.server_default).toBe('mentions')
    expect(s.push_notifications).toBe(true)
    expect(s.overrides).toEqual([{ channel_id: 'c1', category_id: null, level: null, muted: false, muted_until: null }])
  })
})
