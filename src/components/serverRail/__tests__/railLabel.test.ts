/**
 * Rail entry names: the badge, pill and dimming in words.
 */

import { describe, expect, it } from 'vitest'
import { railLabel } from '../railLabel'

const en: Record<string, (n: number) => string> = {
  'chatNav.rail.folder': () => 'folder',
  'chatNav.rail.servers': (n) => (n === 1 ? '1 server' : `${n} servers`),
  'chatNav.channel.mentions': (n) => (n === 1 ? '1 mention' : `${n} mentions`),
  'chatNav.channel.unread': () => 'unread',
  'chatNav.channel.muted': () => 'muted',
}
const t = (key: string, _named?: Record<string, unknown>, plural?: number) => en[key]?.(plural ?? 0) ?? key

describe('railLabel', () => {
  it('is the name alone for a quiet server', () => {
    expect(railLabel(t, 'Harmony', { mentions: 0, unread: false, muted: false })).toBe('Harmony')
  })

  it('says mentions, else unread, then muted', () => {
    expect(railLabel(t, 'Harmony', { mentions: 3, unread: true })).toBe('Harmony, 3 mentions')
    expect(railLabel(t, 'Harmony', { mentions: 1, unread: true, muted: true })).toBe('Harmony, 1 mention, muted')
    expect(railLabel(t, 'Harmony', { mentions: 0, unread: true })).toBe('Harmony, unread')
    expect(railLabel(t, 'Harmony', { mentions: 0, unread: false, muted: true })).toBe('Harmony, muted')
  })

  it('names a folder and its server count first', () => {
    expect(railLabel(t, 'Games', { servers: 4, mentions: 2, unread: true })).toBe('Games, folder, 4 servers, 2 mentions')
    expect(railLabel(t, 'Games', { servers: 1, mentions: 0, unread: false })).toBe('Games, folder, 1 server')
  })
})
