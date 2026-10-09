/**
 * The reactions list shows one tab per emoji with its count and, for the
 * selected tab, every reactor: Harmony users with their handle, bridged Discord
 * users with their Discord name and badge, bots with a bot tag. It follows the
 * reactions store live.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import type { ReactionGroup } from '@/types'
import type { ReactionUserResolvers } from '@/utils/reactionUsers'

const state = vi.hoisted(() => ({ store: null as null | { groups: Record<string, any[]> } }))

vi.mock('@/stores/useReactions', () => ({
  useReactionsStore: () => ({
    getMessageReactions: (messageId: string) => state.store!.groups[messageId] ?? [],
  }),
}))
vi.mock('@/services/unifiedEmojiService', () => ({
  useUnifiedEmoji: () => ({
    resolveEmoji: (id: string) => ({ display: { type: 'native', content: id }, shortcode: `sc-${id}`, unicode: id }),
  }),
}))
vi.mock('@/utils/emojiUtils', () => ({ getEmojiUrl: (url: string) => url }))

import ReactionsModal from '../ReactionsModal.vue'

state.store = reactive({ groups: {} as Record<string, any[]> })

const thumbs = (): ReactionGroup => ({
  emoji_id: null,
  emoji: { id: '👍', name: '👍', url: '', content: '👍', is_native: true } as any,
  count: 2,
  current_user_reacted: false,
  reactions: [
    { reaction_id: 'r1', user_id: 'u-alice' },
    {
      reaction_id: 'r2',
      user_id: 'bridge-bot-profile',
      metadata: { discord_user: { id: '1234', username: 'disco', display_name: 'Disco Dan', avatar_url: 'https://cdn/disco.png' } },
    },
  ],
})

const partyEmojiId = '11111111-2222-3333-4444-555555555555'
const party = (): ReactionGroup => ({
  emoji_id: partyEmojiId,
  emoji: { id: partyEmojiId, name: 'party', url: 'https://cdn/party.png', is_native: false } as any,
  count: 1,
  current_user_reacted: true,
  reactions: [{ reaction_id: 'r3', bot_id: 'bot-1' }],
})

const resolvers = (): ReactionUserResolvers & { preload: ReturnType<typeof vi.fn> } => ({
  displayName: (id) => ({ 'u-alice': 'Alice', 'u-bob': 'Bob' } as Record<string, string>)[id] ?? 'Unknown User',
  avatarUrl: (id) => `/avatars/${id}.png`,
  color: () => '#abcdef',
  handle: (id) => ({ 'u-alice': '@alice', 'u-bob': '@bob@remote.example' } as Record<string, string>)[id] ?? null,
  bot: (id) => (id === 'bot-1' ? { displayName: 'Helper Bot', avatarUrl: '/bot.png', username: 'helper' } : null),
  preload: vi.fn(),
})

const mountModal = (props: { initialEmojiKey?: string | null; resolvers?: ReactionUserResolvers } = {}) =>
  mount(ReactionsModal, {
    props: { messageId: 'm1', initialEmojiKey: props.initialEmojiKey ?? null, resolvers: props.resolvers ?? resolvers() },
    global: {
      mocks: { $t: (key: string) => key },
      stubs: {
        BaseModal: { emits: ['close'], template: '<div class="base-modal-stub"><slot /></div>' },
        Avatar: { props: ['src'], template: '<img class="avatar-stub" :src="src" />' },
        DisplayName: { props: ['fallback'], template: '<span class="display-name-stub">{{ fallback }}</span>' },
        BridgeSourceBadge: { props: ['source'], template: '<span class="bridge-badge-stub">{{ source }}</span>' },
        Icon: true,
      },
    },
  })

const tabKeys = (wrapper: ReturnType<typeof mountModal>) =>
  wrapper.findAll('[data-testid="reactions-modal-tab"]').map(t => t.attributes('data-emoji-key'))

const selectedTab = (wrapper: ReturnType<typeof mountModal>) =>
  wrapper.find('[data-testid="reactions-modal-tab"][aria-selected="true"]').attributes('data-emoji-key')

const userRows = (wrapper: ReturnType<typeof mountModal>) =>
  wrapper.findAll('[data-testid="reactions-modal-user"]').map(row => row.text())

beforeEach(() => {
  state.store!.groups = { m1: [thumbs(), party()] }
})

describe('ReactionsModal', () => {
  it('renders one tab per emoji with its count', () => {
    const wrapper = mountModal()
    expect(tabKeys(wrapper)).toEqual(['👍', partyEmojiId])
    expect(wrapper.findAll('[data-testid="reactions-modal-tab-count"]').map(c => c.text())).toEqual(['2', '1'])
    expect(wrapper.find(`[data-emoji-key="${partyEmojiId}"] img`).attributes('src')).toBe('https://cdn/party.png')
    expect(wrapper.find('[data-emoji-key="👍"]').attributes('title')).toBe(':sc-👍:')
  })

  it('lists Harmony users with handles and bridged Discord users with their Discord identity', () => {
    const wrapper = mountModal()
    expect(selectedTab(wrapper)).toBe('👍')
    const rows = wrapper.findAll('[data-testid="reactions-modal-user"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('Alice')
    expect(rows[0].text()).toContain('@alice')
    expect(rows[0].find('.bridge-badge-stub').exists()).toBe(false)
    expect(rows[1].text()).toContain('Disco Dan')
    expect(rows[1].text()).toContain('@disco')
    expect(rows[1].find('.bridge-badge-stub').text()).toBe('discord')
    expect(rows[1].find('.avatar-stub').attributes('src')).toBe('https://cdn/disco.png')
  })

  it('opens on the requested emoji and switches tabs on click', async () => {
    const wrapper = mountModal({ initialEmojiKey: partyEmojiId })
    expect(selectedTab(wrapper)).toBe(partyEmojiId)
    expect(userRows(wrapper)).toHaveLength(1)
    expect(userRows(wrapper)[0]).toContain('Helper Bot')
    expect(userRows(wrapper)[0]).toContain('bots.badge.bot')

    await wrapper.find('[data-emoji-key="👍"]').trigger('click')
    expect(selectedTab(wrapper)).toBe('👍')
    expect(userRows(wrapper)).toHaveLength(2)
  })

  it('moves between tabs with the arrow keys', async () => {
    const wrapper = mountModal()
    await wrapper.find('[role="tablist"]').trigger('keydown', { key: 'ArrowDown' })
    expect(selectedTab(wrapper)).toBe(partyEmojiId)
    await wrapper.find('[role="tablist"]').trigger('keydown', { key: 'ArrowDown' })
    expect(selectedTab(wrapper)).toBe('👍')
  })

  it('follows live updates of the reactions store', async () => {
    const wrapper = mountModal()
    const updated = thumbs()
    updated.count = 3
    updated.reactions.push({ reaction_id: 'r4', user_id: 'u-bob' })
    state.store!.groups = { m1: [updated, party()] }
    await nextTick()
    expect(wrapper.find('[data-testid="reactions-modal-tab-count"]').text()).toBe('3')
    expect(userRows(wrapper).at(-1)).toContain('@bob@remote.example')
  })

  it('falls back to the first tab when the selected emoji is removed', async () => {
    const wrapper = mountModal({ initialEmojiKey: partyEmojiId })
    state.store!.groups = { m1: [thumbs()] }
    await nextTick()
    expect(tabKeys(wrapper)).toEqual(['👍'])
    expect(selectedTab(wrapper)).toBe('👍')
  })

  it('shows an empty state once every reaction is gone', async () => {
    const wrapper = mountModal()
    state.store!.groups = { m1: [] }
    await nextTick()
    expect(wrapper.find('[data-testid="reactions-modal-empty"]').exists()).toBe(true)
    expect(wrapper.find('[role="tablist"]').exists()).toBe(false)
  })

  it('preloads every reactor and emits the clicked user', async () => {
    const r = resolvers()
    const wrapper = mountModal({ resolvers: r })
    expect(r.preload).toHaveBeenCalledTimes(1)
    expect(r.preload.mock.calls[0][0].map((a: any) => a.reaction_id)).toEqual(['r1', 'r2', 'r3'])

    await wrapper.findAll('[data-testid="reactions-modal-user"]')[1].trigger('click')
    const [user] = wrapper.emitted('select-user')![0] as any[]
    expect(user).toMatchObject({ kind: 'discord', id: '1234', displayName: 'Disco Dan' })
  })
})
