/**
 * A reaction pill opens the reactions list on long-press (touch) and on
 * right-click, on that pill's emoji. A short tap still toggles the reaction.
 * Right-click stays on the pill; the message row's own menu never sees it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { h, ref } from 'vue'

const state = vi.hoisted(() => ({ groups: [] as any[], toggleReaction: null as any }))

vi.mock('@/stores/useReactions', () => ({
  useReactionsStore: () => ({
    getMessageReactions: () => state.groups,
    isLoadingReactions: () => false,
    fetchMessageReactions: vi.fn(),
    toggleReaction: state.toggleReaction,
  }),
}))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profileId: 'me' }) }))
vi.mock('@/stores/useTheme', () => ({ useThemeStore: () => ({ playAudio: vi.fn() }) }))
vi.mock('@/composables/useHapticSettings', () => ({
  useHapticSettings: () => ({ triggerReaction: vi.fn(), triggerInteraction: vi.fn() }),
}))
vi.mock('@/composables/useFrequentEmojis', () => ({ useFrequentEmojis: () => ({ recordEmojiUsage: vi.fn(), topEmojisForPicker: ref([]) }) }))
vi.mock('@/services/unifiedEmojiService', () => ({ useUnifiedEmoji: () => ({ resolveEmoji: () => null }) }))

import MessageReactions from '../MessageReactions.vue'

const message = { id: 'm1', user_id: 'them', content: [], created_at: new Date() } as any
const customId = '11111111-2222-3333-4444-555555555555'

const mountReactions = () => mount(MessageReactions, {
  props: { message },
  global: { stubs: { Icon: true, TransitionGroup: false } },
})

const pill = (wrapper: ReturnType<typeof mountReactions>, key: string) =>
  wrapper.get(`.reaction[data-emoji-key="${key}"]`)

const touch = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }] })

beforeEach(() => {
  vi.useFakeTimers()
  state.toggleReaction = vi.fn(async () => ({ success: true }))
  state.groups = [
    { emoji_id: null, emoji: { name: '👍', content: '👍' }, count: 2, current_user_reacted: false, reactions: [] },
    { emoji_id: customId, emoji: { id: customId, name: 'party', url: 'https://cdn/party.png' }, count: 1, current_user_reacted: false, reactions: [] },
  ]
})

afterEach(() => {
  vi.useRealTimers()
})

describe('MessageReactions pill gestures', () => {
  it('opens the reactions list on the long-pressed emoji', async () => {
    const wrapper = mountReactions()
    await pill(wrapper, customId).trigger('touchstart', touch(20, 20))
    vi.advanceTimersByTime(449)
    expect(wrapper.emitted('open-reactions')).toBeUndefined()
    vi.advanceTimersByTime(1)
    expect(wrapper.emitted('open-reactions')).toEqual([['m1', customId]])

    const end = new TouchEvent('touchend', { bubbles: true, cancelable: true })
    pill(wrapper, customId).element.dispatchEvent(end)
    expect(end.defaultPrevented).toBe(true)
    expect(state.toggleReaction).not.toHaveBeenCalled()
  })

  it('keeps a long-press alive through jitter and cancels it on a drag', async () => {
    const wrapper = mountReactions()
    const target = pill(wrapper, '👍')
    await target.trigger('touchstart', touch(20, 20))
    await target.trigger('touchmove', touch(26, 27))
    vi.advanceTimersByTime(450)
    expect(wrapper.emitted('open-reactions')).toEqual([['m1', '👍']])
    await target.trigger('touchend')

    await target.trigger('touchstart', touch(20, 20))
    await target.trigger('touchmove', touch(20, 40))
    vi.advanceTimersByTime(1000)
    expect(wrapper.emitted('open-reactions')).toHaveLength(1)
  })

  it('toggles on a short tap without opening the list', async () => {
    const wrapper = mountReactions()
    const target = pill(wrapper, '👍')
    await target.trigger('touchstart', touch(20, 20))
    vi.advanceTimersByTime(200)
    const end = new TouchEvent('touchend', { bubbles: true, cancelable: true })
    target.element.dispatchEvent(end)
    expect(end.defaultPrevented).toBe(false)
    await target.trigger('click')
    vi.advanceTimersByTime(1000)
    expect(wrapper.emitted('open-reactions')).toBeUndefined()
    expect(state.toggleReaction).toHaveBeenCalledWith('m1', '👍', 'me', expect.anything())
  })

  it('opens the list on right-click and keeps the event from the message row', async () => {
    const rowContextMenu = vi.fn()
    const opened = vi.fn()
    const wrapper = mount({
      render: () => h('div', { class: 'message-item', onContextmenu: rowContextMenu }, [
        h(MessageReactions, { message, onOpenReactions: opened }),
      ]),
    }, { global: { stubs: { Icon: true, TransitionGroup: false } } })

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    wrapper.get(`.reaction[data-emoji-key="${customId}"]`).element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(opened).toHaveBeenCalledWith('m1', customId)
    expect(rowContextMenu).not.toHaveBeenCalled()
  })

  it('opens once when the browser fires contextmenu during a long-press', async () => {
    const wrapper = mountReactions()
    const target = pill(wrapper, '👍')
    await target.trigger('touchstart', touch(20, 20))
    vi.advanceTimersByTime(400)
    await target.trigger('contextmenu')
    vi.advanceTimersByTime(500)
    expect(wrapper.emitted('open-reactions')).toEqual([['m1', '👍']])

    const end = new TouchEvent('touchend', { bubbles: true, cancelable: true })
    target.element.dispatchEvent(end)
    expect(end.defaultPrevented).toBe(true)
  })
})
