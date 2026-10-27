/**
 * Hover cards open after a rest and close after a grace period that the card itself holds
 * open; a pinned card ignores hover; a second click on the same emoji closes it; the mobile
 * layout and long-press open a sheet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const layout = vi.hoisted(() => ({ mobile: false }))
vi.mock('@/composables/useLayoutState', () => ({ isMobileLayout: () => layout.mobile }))

import {
  EMOJI_INFO_HOVER_DELAY_MS,
  EMOJI_INFO_HOVER_GRACE_MS,
  closeEmojiInfo,
  dismissHoverEmojiInfo,
  holdEmojiInfo,
  hoverEmojiInfo,
  leaveEmojiInfo,
  openEmojiInfo,
  useEmojiInfo,
} from '@/composables/useEmojiInfo'
import type { EmojiInfoTarget } from '@/utils/emojiInfoTarget'

const target: EmojiInfoTarget = { kind: 'default', glyph: '🧹', shortcode: 'broom', imageUrl: null }
const { request } = useEmojiInfo()
let a: HTMLElement
let b: HTMLElement

beforeEach(() => {
  vi.useFakeTimers()
  layout.mobile = false
  window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia
  a = document.body.appendChild(document.createElement('span'))
  b = document.body.appendChild(document.createElement('span'))
})

afterEach(() => {
  closeEmojiInfo()
  a.remove()
  b.remove()
  vi.useRealTimers()
})

describe('hover', () => {
  it('opens after the rest delay and closes after the grace period', () => {
    hoverEmojiInfo(a, target)
    vi.advanceTimersByTime(EMOJI_INFO_HOVER_DELAY_MS - 1)
    expect(request.value).toBeNull()
    vi.advanceTimersByTime(1)
    expect(request.value).toMatchObject({ mode: 'hover', anchor: a })
    leaveEmojiInfo()
    vi.advanceTimersByTime(EMOJI_INFO_HOVER_GRACE_MS)
    expect(request.value).toBeNull()
  })

  it('stays open while the pointer is on the card', () => {
    hoverEmojiInfo(a, target)
    vi.advanceTimersByTime(EMOJI_INFO_HOVER_DELAY_MS)
    leaveEmojiInfo()
    holdEmojiInfo()
    vi.advanceTimersByTime(EMOJI_INFO_HOVER_GRACE_MS * 4)
    expect(request.value).toMatchObject({ mode: 'hover' })
  })

  it('leaving before the delay opens nothing', () => {
    hoverEmojiInfo(a, target)
    leaveEmojiInfo()
    vi.advanceTimersByTime(EMOJI_INFO_HOVER_DELAY_MS * 2)
    expect(request.value).toBeNull()
  })

  it('does nothing on a device without hover', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia
    hoverEmojiInfo(a, target)
    vi.advanceTimersByTime(EMOJI_INFO_HOVER_DELAY_MS)
    expect(request.value).toBeNull()
  })

  it('a pinned card ignores hover and dismissHover', () => {
    openEmojiInfo(a, target, { via: 'click' })
    hoverEmojiInfo(b, target)
    vi.advanceTimersByTime(EMOJI_INFO_HOVER_DELAY_MS)
    dismissHoverEmojiInfo()
    expect(request.value).toMatchObject({ mode: 'pinned', anchor: a })
  })
})

describe('open', () => {
  it('a click pins; a second click on the same emoji closes', () => {
    openEmojiInfo(a, target, { via: 'click' })
    expect(request.value).toMatchObject({ mode: 'pinned' })
    openEmojiInfo(a, target, { via: 'click' })
    expect(request.value).toBeNull()
  })

  it('a click pins over a hover card', () => {
    hoverEmojiInfo(a, target)
    vi.advanceTimersByTime(EMOJI_INFO_HOVER_DELAY_MS)
    openEmojiInfo(a, target, { via: 'click' })
    expect(request.value).toMatchObject({ mode: 'pinned', anchor: a })
  })

  it('long-press and the mobile layout open a sheet', () => {
    openEmojiInfo(a, target, { via: 'press' })
    expect(request.value).toMatchObject({ mode: 'sheet' })
    closeEmojiInfo()
    layout.mobile = true
    openEmojiInfo(a, target, { via: 'click' })
    expect(request.value).toMatchObject({ mode: 'sheet' })
  })
})
