import { describe, it, expect } from 'vitest'
import {
  allowedExpiryChoices,
  allowedMaxUseChoices,
  buildInviteUrl,
  durationParts,
  inviteCodeFromUrl,
  isInviteActive,
  pickChoice,
  timeUntil,
} from '@/utils/inviteLink'

const NOW = Date.parse('2026-10-01T12:00:00Z')
const base = { used: false, expires_at: null as string | null, uses: 0, max_uses: null as number | null }

describe('allowedExpiryChoices', () => {
  it('offers every choice, never included, without a cap', () => {
    expect(allowedExpiryChoices(0)).toEqual([30, 60, 360, 720, 1440, 10080, 0])
  })

  it('drops never and anything past the cap', () => {
    expect(allowedExpiryChoices(1440)).toEqual([30, 60, 360, 720, 1440])
  })
})

describe('allowedMaxUseChoices', () => {
  it('offers unlimited without a limit', () => {
    expect(allowedMaxUseChoices(0)).toContain(0)
  })

  it('drops unlimited and anything past the limit', () => {
    expect(allowedMaxUseChoices(10)).toEqual([1, 5, 10])
  })
})

describe('pickChoice', () => {
  it('keeps an allowed value', () => {
    expect(pickChoice([30, 60, 1440], 60)).toBe(60)
  })

  it('falls back to the largest allowed value below the wanted one', () => {
    expect(pickChoice([30, 60, 360], 720)).toBe(360)
  })

  it('ranks 0 above every finite value', () => {
    expect(pickChoice([30, 60, 1440], 0)).toBe(1440)
  })

  it('falls back to the first choice when nothing is smaller', () => {
    expect(pickChoice([60, 360], 30)).toBe(60)
  })
})

describe('isInviteActive', () => {
  it('accepts an open, unexpired invite', () => {
    expect(isInviteActive({ ...base, expires_at: '2026-10-02T12:00:00Z' }, NOW)).toBe(true)
  })

  it('rejects a revoked invite', () => {
    expect(isInviteActive({ ...base, used: true }, NOW)).toBe(false)
  })

  it('rejects an expired invite', () => {
    expect(isInviteActive({ ...base, expires_at: '2026-10-01T11:59:00Z' }, NOW)).toBe(false)
  })

  it('rejects an invite at its use cap', () => {
    expect(isInviteActive({ ...base, uses: 5, max_uses: 5 }, NOW)).toBe(false)
  })
})

describe('durationParts', () => {
  it('uses the largest exact unit', () => {
    expect(durationParts(10080)).toEqual({ unit: 'day', count: 7 })
    expect(durationParts(360)).toEqual({ unit: 'hour', count: 6 })
    expect(durationParts(30)).toEqual({ unit: 'minute', count: 30 })
    expect(durationParts(90)).toEqual({ unit: 'minute', count: 90 })
  })
})

describe('timeUntil', () => {
  it('rounds within the largest unit that reaches 1', () => {
    expect(timeUntil('2026-10-04T13:00:00Z', NOW)).toEqual({ value: 3, unit: 'day' })
    expect(timeUntil('2026-10-01T17:59:00Z', NOW)).toEqual({ value: 6, unit: 'hour' })
    expect(timeUntil('2026-10-01T12:20:00Z', NOW)).toEqual({ value: 20, unit: 'minute' })
  })

  it('reads a fresh one-day link as one day', () => {
    expect(timeUntil('2026-10-02T11:59:00Z', NOW)).toEqual({ value: 1, unit: 'day' })
  })

  it('reports at least one minute', () => {
    expect(timeUntil('2026-10-01T12:00:20Z', NOW)).toEqual({ value: 1, unit: 'minute' })
  })
})

describe('invite URLs', () => {
  it('round-trips a code', () => {
    const url = buildInviteUrl('QROALVQH', 'https://har.mony.lol/')
    expect(url).toBe('https://har.mony.lol/invite/QROALVQH')
    expect(inviteCodeFromUrl(url)).toBe('QROALVQH')
  })

  it('returns null for a URL without a code', () => {
    expect(inviteCodeFromUrl('https://har.mony.lol/chat')).toBeNull()
  })
})
