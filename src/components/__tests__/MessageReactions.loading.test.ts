/**
 * The reactions bar holds row height only when there are reactions: a fetch in
 * flight for a message with none (every message as it arrives, every sent
 * message as its optimistic row turns real) adds no blank bar.
 */

import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'

const state = vi.hoisted(() => ({ groups: [] as any[], loading: true }))

vi.mock('@/stores/useReactions', () => ({
  useReactionsStore: () => ({
    getMessageReactions: () => state.groups,
    isLoadingReactions: () => state.loading,
    fetchMessageReactions: vi.fn(),
  }),
}))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profileId: 'me' }) }))
vi.mock('@/stores/useTheme', () => ({ useThemeStore: () => ({ playAudio: vi.fn() }) }))
vi.mock('@/composables/useHapticSettings', () => ({ useHapticSettings: () => ({ triggerReaction: vi.fn() }) }))
vi.mock('@/composables/useFrequentEmojis', () => ({ useFrequentEmojis: () => ({ recordEmojiUsage: vi.fn(), topEmojisForPicker: ref([]) }) }))
vi.mock('@/services/unifiedEmojiService', () => ({ useUnifiedEmoji: () => ({ resolveEmoji: () => null }) }))

import MessageReactions from '../MessageReactions.vue'

const message = { id: 'm1', user_id: 'them', content: [], created_at: new Date() } as any

describe('MessageReactions while loading', () => {
  it('renders no bar for a message without reactions', () => {
    state.groups = []
    state.loading = true
    const w = mount(MessageReactions, { props: { message }, global: { stubs: { Icon: true } } })
    expect(w.find('[data-testid="message-reactions"]').exists()).toBe(false)
  })

  it('keeps the bar of a message with reactions during a refresh', () => {
    state.groups = [{ emoji_id: '👍', emoji: { name: '👍', content: '👍' }, count: 2, current_user_reacted: false, users: [] }]
    state.loading = true
    const w = mount(MessageReactions, { props: { message }, global: { stubs: { Icon: true } } })
    expect(w.find('[data-testid="message-reactions"]').exists()).toBe(true)
  })
})
