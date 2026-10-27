/**
 * PostReactions.vue chips for keyboard and screen readers: a named group of toggle
 * buttons, each named by its emoji and count with aria-pressed for the caller's own
 * reaction, who reacted as the description, and the tooltip opening on focus too.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
    locale: { value: 'en' },
  }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }) }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profileId: 'me' }) }))
vi.mock('@/stores/useTheme', () => ({ useThemeStore: () => ({ playAudio: vi.fn() }) }))
vi.mock('@/stores/useInstanceSettings', () => ({ useInstanceSettingsStore: () => ({ settings: { maxPostReactionsPerUser: 5 } }) }))
vi.mock('@/composables/useHapticSettings', () => ({ useHapticSettings: () => ({ triggerReaction: vi.fn() }) }))
vi.mock('@/composables/useFrequentEmojis', () => ({ useFrequentEmojis: () => ({ recordEmojiUsage: vi.fn() }) }))
vi.mock('@/services/PostReactionsRealtime', () => ({ postReactionsRealtime: { subscribe: vi.fn(), unsubscribe: vi.fn() } }))

import { usePostReactionsStore } from '@/stores/postReactions'
import PostReactions from '../PostReactions.vue'

const group = (content: string, mine: boolean, users: string[]) => ({
  emoji_id: null,
  emoji_name: null,
  emoji_url: null,
  custom_emoji_content: content,
  reaction_count: users.length,
  current_user_reacted: mine,
  user_reactions: users.map((name, i) => ({ user_id: `u${i}`, username: name.toLowerCase(), display_name: name, avatar_url: '', created_at: '' })),
})

const post = { id: 'post-1', metadata: {} } as any

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('PostReactions chips', () => {
  it('are toggle buttons in a named toolbar, named by emoji and count, described by who reacted', () => {
    usePostReactionsStore().bulkSetReactions({
      'post-1': [group('🎉', true, ['Alice', 'Bob']), group(':blob_cat@remote.example:', false, ['Carol'])] as any,
    })
    const wrapper = mount(PostReactions, { props: { post }, global: { stubs: { LoadingSpinner: true, Icon: true } } })

    const groupEl = wrapper.get('[role="toolbar"]')
    expect(groupEl.attributes('aria-label')).toBe('activitypub.reactionsA11y.group')

    const chips = wrapper.findAll('button.reaction')
    expect(chips).toHaveLength(2)
    expect(chips[0].attributes('aria-pressed')).toBe('true')
    expect(chips[0].attributes('aria-label')).toBe('activitypub.reactionsA11y.chip:{"emoji":"🎉","count":2}')
    expect(chips[1].attributes('aria-pressed')).toBe('false')
    expect(chips[1].attributes('aria-label')).toBe('activitypub.reactionsA11y.chip:{"emoji":"blob cat","count":1}')

    const description = wrapper.get(`#${chips[0].attributes('aria-describedby')}`)
    expect(description.text()).toBe('activitypub.reactionsA11y.reactedBy:{"names":"Alice and Bob"}')
  })

  it('opens the reactor tooltip on keyboard focus and closes it on blur', async () => {
    usePostReactionsStore().bulkSetReactions({ 'post-1': [group('👀', false, ['Dana'])] as any })
    const wrapper = mount(PostReactions, { props: { post }, global: { stubs: { LoadingSpinner: true, Icon: true } } })
    const chip = wrapper.get('button.reaction')
    await chip.trigger('focus')
    expect(wrapper.emitted('show-reaction-tooltip')?.[0]?.[1]).toMatchObject({ custom_emoji_content: '👀' })
    await chip.trigger('blur')
    expect(wrapper.emitted('hide-reaction-tooltip')).toHaveLength(1)
  })
})
