import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import {
  CLEAR_MS,
  MAX_JOINED,
  THROTTLE_MS,
  WRITE_DELAY_MS,
  announcerRegions,
  resetAnnouncer,
  setAnnouncerMoreLabel,
  setVerboseAnnouncements,
  useAnnouncer,
} from '../useAnnouncer'
import LiveAnnouncer from '@/components/a11y/LiveAnnouncer.vue'

const { politeText, assertiveText } = announcerRegions()

/** Runs a flush and the clear-then-write step. */
function settle() {
  vi.advanceTimersByTime(THROTTLE_MS + WRITE_DELAY_MS + 1)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-11T12:00:00Z'))
  resetAnnouncer()
  setVerboseAnnouncements(false)
  setAnnouncerMoreLabel((n) => `${n} more`)
})

afterEach(() => {
  resetAnnouncer()
  vi.useRealTimers()
})

describe('useAnnouncer', () => {
  it('writes polite and assertive text to separate regions', () => {
    const { polite, assertive } = useAnnouncer()
    polite('Saved')
    assertive('Connection lost')
    settle()
    expect(politeText.value).toBe('Saved')
    expect(assertiveText.value).toBe('Connection lost')
  })

  it('joins a burst into one announcement and summarises the overflow', () => {
    const { polite } = useAnnouncer()
    for (let i = 1; i <= MAX_JOINED + 2; i++) polite(`Message ${i}`)
    settle()
    expect(politeText.value).toBe('Message 1. Message 2. Message 3. Message 4. 2 more')
  })

  it('drops identical text inside the dedupe window', () => {
    const { polite } = useAnnouncer()
    polite('Copied')
    polite('Copied')
    settle()
    expect(politeText.value).toBe('Copied')
    vi.advanceTimersByTime(CLEAR_MS)
    expect(politeText.value).toBe('')
    vi.advanceTimersByTime(1000)
    polite('Copied')
    settle()
    expect(politeText.value).toBe('Copied')
  })

  it('replaces a pending announcement with the same key', () => {
    const { polite } = useAnnouncer()
    polite('Alice is typing', { key: 'typing' })
    polite('Alice and Bob are typing', { key: 'typing' })
    settle()
    expect(politeText.value).toBe('Alice and Bob are typing')
  })

  it('drops verbose announcements unless verbose mode is on', () => {
    const { polite } = useAnnouncer()
    polite('Alice is speaking', { verbose: true })
    settle()
    expect(politeText.value).toBe('')
    setVerboseAnnouncements(true)
    polite('Alice is speaking', { verbose: true })
    settle()
    expect(politeText.value).toBe('Alice is speaking')
  })

  it('ignores blank text and collapses whitespace', () => {
    const { polite } = useAnnouncer()
    polite('   ')
    polite('  two\n words ')
    settle()
    expect(politeText.value).toBe('two words')
  })

  it('clears the region before rewriting so a repeat is spoken again', () => {
    const { polite } = useAnnouncer()
    polite('Muted', { dedupeMs: 0 })
    settle()
    polite('Muted', { dedupeMs: 0 })
    vi.advanceTimersByTime(THROTTLE_MS + 1)
    expect(politeText.value).toBe('')
    vi.advanceTimersByTime(WRITE_DELAY_MS)
    expect(politeText.value).toBe('Muted')
  })
})

describe('LiveAnnouncer', () => {
  it('renders persistent polite and assertive regions outside the app', async () => {
    mount(LiveAnnouncer, { attachTo: document.body })
    const host = document.querySelector('[data-testid="live-announcer"]')!
    expect(host.hasAttribute('data-a11y-persistent')).toBe(true)
    expect(host.parentElement).toBe(document.body)
    const polite = document.querySelector('[data-testid="live-announcer-polite"]')!
    expect(polite.getAttribute('aria-live')).toBe('polite')
    expect(document.querySelector('[data-testid="live-announcer-assertive"]')!.getAttribute('aria-live')).toBe('assertive')
    useAnnouncer().polite('Hello')
    settle()
    await nextTick()
    expect(polite.textContent).toBe('Hello')
  })
})
