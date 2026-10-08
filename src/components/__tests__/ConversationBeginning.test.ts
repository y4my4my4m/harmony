/**
 * Conversation start line: DMs and groups render one sentence with the name
 * through DisplayName, so shortcodes in names become emoji images.
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'
import ConversationBeginning from '@/components/ConversationBeginning.vue'

const fire = { id: 'e1', name: 'fire', url: 'https://cdn.test/fire.png' }
const spiral = { id: 'e2', name: 'har_spiral_eyes', url: 'https://cdn.test/spiral.png' }

vi.mock('@/composables/useUserData', async () => {
  const { ref } = await import('vue')
  return {
    useUserData: () => ({
      getUser: (id: string) => ref(id === 'u1' ? { id } : null),
      getUserDisplayName: () => ref(':fire: y4my4m :har_spiral_eyes:'),
      getUserDisplayNameParts: (id: string) =>
        ref(
          id === 'u1'
            ? [
                { type: 'emoji', emoji: fire },
                { type: 'text', text: ' y4my4m ' },
                { type: 'emoji', emoji: spiral },
              ]
            : undefined,
        ),
      fetchUserProfile: vi.fn(async () => undefined),
    }),
  }
})
vi.mock('@/services/unifiedEmojiService', async () => {
  const { ref } = await import('vue')
  return {
    useUnifiedEmoji: () => ({
      resolveEmoji: (s: string) => ({ display: { type: 'text', content: s } }),
      isNativePack: ref(true),
      isLoaded: ref(true),
    }),
  }
})
vi.mock('@/services/userDataService', () => ({
  userDataService: {
    resolveDisplayNameParts: (text: string) =>
      text === ':fire: crew'
        ? [{ type: 'emoji', emoji: fire }, { type: 'text', text: ' crew' }]
        : [{ type: 'text', text }],
  },
}))
vi.mock('@/utils/emojiUtils', () => ({ getEmojiUrl: (url: string) => url }))

function render(props: Record<string, unknown>) {
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
  return mount(ConversationBeginning, { props, global: { plugins: [i18n] } })
}

describe('ConversationBeginning', () => {
  it('renders a DM partner name with custom emoji and no avatar block', () => {
    const w = render({ kind: 'dm', name: ':fire: y4my4m :har_spiral_eyes:', userId: 'u1' })
    expect(w.find('img.beginning-avatar').exists()).toBe(false)
    expect(w.find('h2').exists()).toBe(false)
    const text = w.find('.beginning-subtitle')
    expect(text.text()).toBe('This is the very beginning of your direct messages with  y4my4m .')
    expect(text.text()).not.toContain(':fire:')
    const imgs = text.findAll('img.display-name-emoji')
    expect(imgs.map((i) => i.attributes('src'))).toEqual([fire.url, spiral.url])
    expect(imgs.map((i) => i.attributes('alt'))).toEqual([':fire:', ':har_spiral_eyes:'])
  })

  it('resolves shortcodes in a group name', () => {
    const w = render({ kind: 'group', name: ':fire: crew' })
    const text = w.find('.beginning-subtitle')
    expect(text.text()).toBe('This is the very beginning of the  crew group.')
    expect(text.find('img.display-name-emoji').attributes('src')).toBe(fire.url)
  })

  it('uses the unnamed sentence for a group without a name', () => {
    const w = render({ kind: 'group', name: '' })
    expect(w.text()).toBe('This is the very beginning of this group.')
  })

  it('keeps the channel welcome heading', () => {
    const w = render({ kind: 'channel', name: 'general' })
    expect(w.find('h2').text()).toBe('Welcome to #general')
    expect(w.find('.beginning-subtitle').text()).toBe('This is the start of the #general channel.')
  })
})
