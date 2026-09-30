import { describe, it, expect } from 'vitest'
import { formatShortRelativeTime, formatFullDateTime } from '@/utils/shortRelativeTime'

const NOW = new Date('2026-06-15T12:00:00Z').getTime()
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe('formatShortRelativeTime', () => {
  it('reads as now under ten seconds and for future timestamps', () => {
    expect(formatShortRelativeTime(ago(3_000), { now: NOW })).toBe('now')
    expect(formatShortRelativeTime(ago(-60_000), { now: NOW })).toBe('now')
    expect(formatShortRelativeTime(ago(0), { now: NOW, nowLabel: 'jetzt' })).toBe('jetzt')
  })

  it('uses narrow units below a week', () => {
    expect(formatShortRelativeTime(ago(42_000), { now: NOW })).toBe('42s')
    expect(formatShortRelativeTime(ago(5 * 60_000), { now: NOW })).toBe('5m')
    expect(formatShortRelativeTime(ago(3 * 3_600_000 + 59 * 60_000), { now: NOW })).toBe('3h')
    expect(formatShortRelativeTime(ago(6 * 86_400_000), { now: NOW })).toBe('6d')
  })

  it('switches to a short date at one week, adding the year only across years', () => {
    expect(formatShortRelativeTime('2026-03-05T10:00:00Z', { now: NOW })).toBe('Mar 5')
    expect(formatShortRelativeTime('2024-03-05T10:00:00Z', { now: NOW })).toBe('Mar 5, 2024')
  })

  it('accepts Date and epoch input and rejects garbage', () => {
    expect(formatShortRelativeTime(new Date(NOW - 120_000), { now: NOW })).toBe('2m')
    expect(formatShortRelativeTime(NOW - 7_200_000, { now: NOW })).toBe('2h')
    expect(formatShortRelativeTime('not a date', { now: NOW })).toBe('')
  })

  it('localizes units', () => {
    expect(formatShortRelativeTime(ago(3 * 86_400_000), { now: NOW, locale: 'fr' })).toBe('3j')
  })
})

describe('formatFullDateTime', () => {
  it('formats a full date and time', () => {
    const out = formatFullDateTime('2026-03-05T10:00:00Z')
    expect(out).toMatch(/Mar 5, 2026/)
  })

  it('returns an empty string for invalid input', () => {
    expect(formatFullDateTime('nope')).toBe('')
  })
})
