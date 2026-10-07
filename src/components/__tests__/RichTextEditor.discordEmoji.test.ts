/**
 * The composer editor shows a Discord token as the emoji image and gives the
 * token back as its plain text.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'

vi.mock('@/composables/useViewport', () => ({
  useViewport: () => ({ isMobileViewport: ref(false), isTouchOnly: false }),
}))
vi.mock('@/composables/useVisualTheme', () => ({
  useVisualTheme: () => ({ currentSettings: ref({ greentextEnabled: true }) }),
}))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ currentServerId: null }),
}))
vi.mock('@/services/RoleService', () => ({
  roleService: { getRolesForServer: vi.fn(async () => []), getRole: vi.fn(async () => null) },
}))
vi.mock('@/services/userDataService', () => ({
  userDataService: { findUserIdByUsername: () => null, getUserProfile: () => null },
}))
vi.mock('@/services/unifiedEmojiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/unifiedEmojiService')>()),
  useUnifiedEmoji: () => ({ isLoaded: ref(false) }),
  loadEmojiData: vi.fn(async () => {}),
}))

import RichTextEditor from '../RichTextEditor.vue'

enableAutoUnmount(afterEach)

const ID = '1376980620600672316'

async function editorWith(text: string) {
  const wrapper = mount(RichTextEditor, { props: { modelValue: text }, attachTo: document.body })
  await nextTick()
  return wrapper
}

describe('RichTextEditor with Discord emoji', () => {
  it('renders the static and animated tokens as images', async () => {
    const text = `hi :discord:heh:${ID}: and :discord:a:wave:${ID}:`
    const wrapper = await editorWith(text)

    const images = wrapper.findAll('.editor-emoji img')
    expect(images.map(img => img.attributes('src'))).toEqual([
      `https://cdn.discordapp.com/emojis/${ID}.png`,
      `https://cdn.discordapp.com/emojis/${ID}.gif`,
    ])
    expect(wrapper.text()).not.toContain('discord:')
    expect((wrapper.vm as unknown as { getPlainText: () => string }).getPlainText()).toBe(text)
  })

  it('keeps an invalid token as text', async () => {
    const text = `:discord:heh:123:`
    const wrapper = await editorWith(text)
    expect(wrapper.findAll('.editor-emoji img')).toHaveLength(0)
    expect((wrapper.vm as unknown as { getPlainText: () => string }).getPlainText()).toBe(text)
  })
})
