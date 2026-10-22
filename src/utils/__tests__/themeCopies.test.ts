import { describe, expect, it } from 'vitest'
import { newerCopy, savedAtOf, stampCopy, withoutStamp, SAVED_AT_KEY } from '@/utils/themeCopies'

describe('themeCopies', () => {
  it('reads the stamp, 0 when absent or not a number', () => {
    expect(savedAtOf({ theme: 'dark', savedAt: 42 })).toBe(42)
    expect(savedAtOf({ theme: 'dark' })).toBe(0)
    expect(savedAtOf({ theme: 'dark', savedAt: 'soon' })).toBe(0)
    expect(savedAtOf(null)).toBe(0)
  })

  it('stamps a copy without touching the original, and strips it again', () => {
    const live = { theme: 'dark' }
    const stamped = stampCopy(live, 7)
    expect(stamped).toEqual({ theme: 'dark', [SAVED_AT_KEY]: 7 })
    expect(live).toEqual({ theme: 'dark' })
    expect(withoutStamp(stamped)).toEqual({ theme: 'dark' })
  })

  it('the device copy wins only when it is newer', () => {
    expect(newerCopy({ theme: 'dark', savedAt: 20 }, { theme: 'light', savedAt: 10 })).toBe('local')
    expect(newerCopy({ theme: 'dark', savedAt: 10 }, { theme: 'light', savedAt: 20 })).toBe('remote')
    expect(newerCopy({ theme: 'dark', savedAt: 10 }, { theme: 'light', savedAt: 10 })).toBe('remote')
  })

  it('an unstamped profile copy wins: a client that does not stamp may have written it later', () => {
    expect(newerCopy({ theme: 'dark', savedAt: 5 }, { theme: 'light' })).toBe('remote')
    expect(newerCopy({ theme: 'dark' }, { theme: 'light' })).toBe('remote')
  })

  it('an unstamped device copy loses to a stamped profile copy', () => {
    expect(newerCopy({ theme: 'dark' }, { theme: 'light', savedAt: 5 })).toBe('remote')
  })

  it('takes whichever copy exists', () => {
    expect(newerCopy({ theme: 'dark' }, null)).toBe('local')
    expect(newerCopy(null, { theme: 'light' })).toBe('remote')
    expect(newerCopy(null, null)).toBeNull()
  })
})
