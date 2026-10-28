import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { focusFromNavigationKey, trackNavigationKeys } from '../focus'

const key = (k: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))

beforeAll(() => trackNavigationKeys())

afterEach(() => {
  key('Escape')
  vi.useRealTimers()
})

describe('focusFromNavigationKey', () => {
  it('is true right after Tab or F6 and false 400 ms on', () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    expect(focusFromNavigationKey()).toBe(false)
    key('Tab')
    expect(focusFromNavigationKey()).toBe(true)
    vi.advanceTimersByTime(400)
    expect(focusFromNavigationKey()).toBe(false)
    key('F6')
    expect(focusFromNavigationKey()).toBe(true)
  })

  it('ends at the next key: focus moved after Enter on a link is not Tab\'s', () => {
    key('Tab')
    key('Enter')
    expect(focusFromNavigationKey()).toBe(false)
    key('Tab')
    key(' ')
    expect(focusFromNavigationKey()).toBe(false)
  })

  it('ends at a pointer press', () => {
    key('Tab')
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(focusFromNavigationKey()).toBe(false)
  })

  it('holds through the Shift of Shift+Tab', () => {
    key('Shift')
    key('Tab')
    expect(focusFromNavigationKey()).toBe(true)
  })
})
