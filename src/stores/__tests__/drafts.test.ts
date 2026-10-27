/**
 * Drafts persist 500 ms after the last keystroke, and at once when the page is hidden or
 * unloaded: a reload, a closed tab or an app sent to the background inside that window keeps
 * the latest text. An emptied draft (a send empties it) is written at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const stored: Record<string, string> = {}
vi.mock('@/utils/userScopedStorage', () => ({
  userStorage: {
    getItem: (key: string) => stored[key] ?? null,
    setItem: (key: string, value: string) => { stored[key] = value },
  },
}))

import { useDraftsStore } from '@/stores/drafts'

const persisted = () => JSON.parse(stored['message-drafts'] ?? '{}')

describe('drafts store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    for (const key of Object.keys(stored)) delete stored[key]
    setActivePinia(createPinia())
  })
  afterEach(() => vi.useRealTimers())

  it('persists after the debounce', () => {
    const drafts = useDraftsStore()
    drafts.saveDraft('channel:a', 'hello')
    expect(persisted()).toEqual({})
    vi.advanceTimersByTime(500)
    expect(persisted()).toEqual({ 'channel:a': 'hello' })
  })

  it('persists at once on pagehide', () => {
    const drafts = useDraftsStore()
    drafts.saveDraft('channel:a', 'typed just before the reload')
    window.dispatchEvent(new Event('pagehide'))
    expect(persisted()).toEqual({ 'channel:a': 'typed just before the reload' })
  })

  it('persists at once when the page is hidden', () => {
    const drafts = useDraftsStore()
    drafts.saveDraft('channel:a', 'app sent to the background')
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    expect(persisted()).toEqual({ 'channel:a': 'app sent to the background' })
  })

  it('writes an emptied draft at once, as a send empties it', () => {
    const drafts = useDraftsStore()
    drafts.saveDraft('channel:a', 'sent text')
    vi.advanceTimersByTime(500)
    drafts.saveDraft('channel:a', '')
    expect(persisted()).toEqual({})
    drafts.saveDraft('channel:b', 'other')
    drafts.clearDraft('channel:b')
    expect(persisted()).toEqual({})
  })

  it('keeps pending text of another draft when one is emptied', () => {
    const drafts = useDraftsStore()
    drafts.saveDraft('channel:a', 'sent text')
    drafts.saveDraft('channel:b', 'still typing')
    drafts.clearDraft('channel:a')
    expect(persisted()).toEqual({ 'channel:b': 'still typing' })
  })
})
