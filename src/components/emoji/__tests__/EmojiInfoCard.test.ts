/**
 * The card says where an emoji comes from as the RPC answered it. 'unavailable' is one
 * generic line with nothing of a server; Join shows only for a joinable server; a reaction
 * card names its first reactors and "and N others".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'
import de from '@/locales/de.json'
import es from '@/locales/es.json'
import fr from '@/locales/fr.json'
import ja from '@/locales/ja.json'
import ko from '@/locales/ko.json'
import zh from '@/locales/zh.json'
import type { EmojiSource } from '@/services/emojiSourceService'
import type { ReactionUser } from '@/utils/reactionUsers'

const state = vi.hoisted(() => ({
  source: { kind: 'unavailable' } as EmojiSource,
  currentServerId: 'here' as string | null,
  joinServer: vi.fn(async () => true),
  fetchServersForUser: vi.fn(async () => {}),
}))

vi.mock('@/services/emojiSourceService', () => ({
  fetchEmojiSource: vi.fn(async () => state.source),
  invalidateEmojiSources: vi.fn(),
}))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ currentServerId: state.currentServerId, fetchServersForUser: state.fetchServersForUser }),
}))
vi.mock('@/stores/server', () => ({ useServerStore: () => ({ joinServer: state.joinServer }) }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profileId: 'me' }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'auth-me' } } }) }))
vi.mock('@/utils/emojiUtils', () => ({ getEmojiUrl: (url: string) => url }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/components/common/Avatar.vue', () => ({ default: defineComponent({ setup: () => () => h('span') }) }))
vi.mock('@/components/common/ServerIcon.vue', () => ({ default: defineComponent({ setup: () => () => h('span', { class: 'server-icon' }) }) }))
vi.mock('@/components/common/Icon.vue', () => ({ default: defineComponent({ setup: () => () => h('i') }) }))
vi.mock('@/components/DisplayName.vue', () => ({
  default: defineComponent({ props: { fallback: String }, setup: (p) => () => h('span', p.fallback) }),
}))

import EmojiInfoCard from '@/components/emoji/EmojiInfoCard.vue'

const custom = { kind: 'custom' as const, id: '11111111-2222-4333-8444-555555555555', name: 'catyes', url: 'https://cdn.test/c.png' }

const server = (over: Record<string, unknown> = {}): EmojiSource => ({
  kind: 'server',
  server: {
    id: 'plaza', name: 'Plaza', icon: null, public: true, memberCount: 3, isMember: false, joinable: true,
    domain: null, emojis: [{ id: 'e2', name: 'other', url: 'https://cdn.test/o.png' }], ...over,
  },
})

async function render(props: Record<string, unknown> = {}) {
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
  const wrapper = mount(EmojiInfoCard, {
    props: { target: custom, titleId: 't', descriptionId: 'd', ...props },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return wrapper
}

const source = (w: Awaited<ReturnType<typeof render>>) => w.get('[data-testid="emoji-info-source"]').text()

beforeEach(() => {
  state.source = { kind: 'unavailable' }
  state.currentServerId = 'here'
  state.joinServer.mockClear()
})

describe('EmojiInfoCard source', () => {
  it('a default emoji says so, and asks nothing', async () => {
    const w = await render({ target: { kind: 'default', glyph: '🧹', shortcode: 'broom', imageUrl: null } })
    expect(w.get('[data-testid="emoji-info-name"]').text()).toBe(':broom:')
    expect(source(w)).toBe('A default emoji. Use it anywhere.')
  })

  it('unavailable is one generic line with no server, and no Join', async () => {
    const w = await render()
    expect(source(w)).toBe('From a server that is private or no longer available.')
    expect(w.find('[data-testid="emoji-info-server"]').exists()).toBe(false)
    expect(w.find('[data-testid="emoji-info-join"]').exists()).toBe(false)
  })

  it('a public server shows its card and Join', async () => {
    state.source = server()
    const w = await render()
    expect(source(w)).toContain('From Plaza, a public server')
    expect(w.get('[data-testid="emoji-info-server-name"]').text()).toBe('Plaza')
    expect(w.findAll('[data-testid="emoji-info-more"] img').map((i) => i.attributes('alt'))).toEqual([':other:'])
    await w.get('[data-testid="emoji-info-join"]').trigger('click')
    await flushPromises()
    expect(state.joinServer).toHaveBeenCalledWith('plaza')
  })

  it('a member of the current server reads "this server" without Join', async () => {
    state.source = server({ id: 'here', isMember: true, joinable: false, public: false })
    const w = await render()
    expect(source(w)).toBe('From this server.')
    expect(w.find('[data-testid="emoji-info-join"]').exists()).toBe(false)
  })

  it('a member of another server reads its name', async () => {
    state.source = server({ isMember: true, joinable: false })
    expect(source(await render())).toBe('From Plaza, one of your servers.')
  })

  it('a personal emoji names its owner, or not', async () => {
    state.source = { kind: 'personal', owner: { id: 'bob', username: 'bob', displayName: 'Bob', avatarUrl: null, domain: null, isLocal: true } }
    expect(source(await render())).toBe('A personal emoji of Bob.')
    state.source = { kind: 'personal', owner: null }
    const w = await render()
    expect(source(w)).toBe('A personal emoji.')
    expect(w.find('[data-testid="emoji-info-owner"]').exists()).toBe(false)
    state.source = { kind: 'personal', owner: { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null, domain: null, isLocal: true } }
    expect(source(await render())).toBe('Your personal emoji. Use it anywhere.')
  })

  it('a remote emoji names its instance; a federated part falls back to its image host', async () => {
    state.source = { kind: 'remote', domain: 'fedi.example' }
    expect(source(await render())).toBe('From another instance: fedi.example.')
    state.source = { kind: 'unavailable' }
    expect(source(await render({ target: { ...custom, id: null, remoteHost: 'img.example' } }))).toBe('From another instance: img.example.')
  })
})

describe('EmojiInfoCard reactions', () => {
  const users = (names: string[]) => names.map((displayName, i) => ({ key: `${i}`, id: `${i}`, displayName }) as ReactionUser)

  it('names three reactors and "and N others"', async () => {
    const w = await render({ reactions: { count: () => 5, users: () => users(['A', 'B', 'C', 'D', 'E']), onShowAll: vi.fn() } })
    expect(w.get('[data-testid="emoji-info-reactors"]').text()).toBe('Reacted by A, B, C and 2 others')
    expect(w.find('[data-testid="emoji-info-all-reactions"]').exists()).toBe(true)
  })

  it('names every reactor when there are few', async () => {
    const w = await render({ reactions: { count: () => 2, users: () => users(['A', 'B']) } })
    expect(w.get('[data-testid="emoji-info-reactors"]').text()).toBe('Reacted by A, B')
    expect(w.find('[data-testid="emoji-info-all-reactions"]').exists()).toBe(false)
  })
})

describe('emojiInfo locales', () => {
  type Tree = Record<string, unknown>
  const leaves = (tree: Tree, prefix = ''): Array<[string, string]> =>
    Object.entries(tree).flatMap(([k, v]) =>
      v && typeof v === 'object' ? leaves(v as Tree, `${prefix}${k}.`) : [[`${prefix}${k}`, String(v)]])
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().filter((v, i, a) => a.indexOf(v) === i)
  const base = new Map(leaves((en as Tree).emojiInfo as Tree))

  it.each(Object.entries({ de, es, fr, ja, ko, zh }))('%s has every key with the same placeholders', (_locale, messages) => {
    const local = new Map(leaves((messages as Tree).emojiInfo as Tree))
    expect([...local.keys()].sort()).toEqual([...base.keys()].sort())
    for (const [key, value] of base) {
      expect([key, placeholders(local.get(key)!)]).toEqual([key, placeholders(value)])
    }
  })
})
