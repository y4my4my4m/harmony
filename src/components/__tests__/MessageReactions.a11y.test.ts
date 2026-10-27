/**
 * Reaction pills are toggle buttons named by emoji, count and whether the viewer
 * reacted; the ContextMenu key and Shift+F10 list who reacted; removing the
 * viewer's only reaction keeps keyboard focus in the message.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'

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
vi.mock('@/services/unifiedEmojiService', () => ({
  useUnifiedEmoji: () => ({
    resolveEmoji: (id: string) => (id === '👍' ? { shortcode: 'thumbs_up', display: { type: 'native', content: '👍' } } : null),
  }),
}))

import MessageReactions from '../MessageReactions.vue'

const message = { id: 'm1', user_id: 'them', content: [], created_at: new Date() } as any
const customId = '11111111-2222-3333-4444-555555555555'

let wrapper: ReturnType<typeof mount> | null = null
const mountReactions = () => {
  wrapper = mount(MessageReactions, {
    props: { message },
    global: { stubs: { Icon: true, TransitionGroup: false } },
    attachTo: document.body,
  })
  return wrapper
}

beforeEach(() => {
  state.toggleReaction = vi.fn(async () => ({ success: true }))
  state.groups = [
    { emoji_id: null, emoji: { name: '👍', content: '👍' }, count: 3, current_user_reacted: true, reactions: [] },
    { emoji_id: customId, emoji: { id: customId, name: 'party_parrot', url: 'https://cdn/party.png' }, count: 1, current_user_reacted: false, reactions: [] },
  ]
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('MessageReactions for screen readers', () => {
  it('renders toggle buttons named by emoji, count and the viewer', () => {
    const w = mountReactions()
    const [thumbs, parrot] = w.findAll('button.reaction')
    expect(thumbs.attributes('aria-pressed')).toBe('true')
    expect(thumbs.attributes('aria-label')).toBe('messageA11y.reactions.pillYou')
    expect(parrot.attributes('aria-pressed')).toBe('false')
    expect(parrot.attributes('aria-label')).toBe('messageA11y.reactions.pill')
    expect(parrot.get('img').attributes('alt')).toBe(':party_parrot:')
    expect(w.get('[role="toolbar"]').attributes('aria-label')).toBe('message.reactions.title')
    expect(w.get('.add-reaction-btn').attributes('aria-label')).toBe('message.reactions.add')
    // Every pill points at the hint that says how to list who reacted.
    const hint = w.get('.sr-only')
    expect(thumbs.attributes('aria-describedby')).toBe(hint.attributes('id'))
  })

  it('is one Tab stop; Left and Right move between pills and the add button', async () => {
    const w = mountReactions()
    const buttons = () => w.findAll('[role="toolbar"] button').map((b) => b.element as HTMLElement)
    expect(buttons().map((b) => b.getAttribute('tabindex'))).toEqual(['0', '-1', '-1'])
    buttons()[0].focus()
    buttons()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(buttons()[1])
    expect(buttons().map((b) => b.getAttribute('tabindex'))).toEqual(['-1', '0', '-1'])
    buttons()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(buttons()[0])
    // Home/End belong to the message list around the reactions.
    const end = new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })
    buttons()[0].dispatchEvent(end)
    expect(end.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(buttons()[0])
  })

  it('lists who reacted on the ContextMenu key and Shift+F10', async () => {
    const w = mountReactions()
    const pill = w.get(`button.reaction[data-emoji-key="${customId}"]`)
    await pill.trigger('keydown', { key: 'ContextMenu' })
    await pill.trigger('keydown', { key: 'F10', shiftKey: true })
    expect(w.emitted('open-reactions')).toEqual([['m1', customId], ['m1', customId]])
  })

  it('toggles from the keyboard through the store', async () => {
    const w = mountReactions()
    await w.get(`button.reaction[data-emoji-key="${customId}"]`).trigger('click')
    expect(state.toggleReaction).toHaveBeenCalledWith('m1', customId, 'me', expect.objectContaining({ name: 'party_parrot' }))
  })

  it('moves focus to the add button when the viewer\'s only reaction goes', async () => {
    state.groups = [
      { emoji_id: null, emoji: { name: '👍', content: '👍' }, count: 1, current_user_reacted: true, reactions: [] },
      { emoji_id: customId, emoji: { id: customId, name: 'party_parrot', url: 'https://cdn/party.png' }, count: 2, current_user_reacted: false, reactions: [] },
    ]
    const w = mountReactions()
    const pill = w.get('button.reaction[data-emoji-key="👍"]')
    ;(pill.element as HTMLElement).focus()
    state.toggleReaction = vi.fn(async () => {
      state.groups = state.groups.slice(1)
      return { success: true }
    })
    await pill.trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(w.get('.add-reaction-btn').element)
  })
})
