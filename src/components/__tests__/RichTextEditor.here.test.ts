/**
 * The composer editor shows @role:here as an @here pill and a bridged person's token as an
 * @name pill, and gives each token back as its plain text, as it does @role:UUID.
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

async function editorWith(text: string) {
  const wrapper = mount(RichTextEditor, { props: { modelValue: text }, attachTo: document.body })
  await nextTick()
  return wrapper
}

describe('RichTextEditor mention pills', () => {
  it.each([
    ['<@matrix:%40sam%3Aexample.org%3A8448>', 'Matrix: @sam'],
    ['@d!123456789:sam', 'Discord: @sam'],
  ])('shows %s as an @name pill and keeps the token for sends and edits', async (token, title) => {
    const text = `hello ${token} there`
    const wrapper = await editorWith(text)
    const pill = wrapper.get('.editor-bridged-mention')
    expect(pill.text()).toBe('@sam')
    expect(pill.attributes('title')).toBe(title)
    expect(pill.attributes('data-display-text')).toBe(token)
    expect((wrapper.vm as unknown as { getPlainText: () => string }).getPlainText()).toBe(text)
  })

  it.each(['<@matrix:%ZZ>', '<@matrix:%40sam%3Aexample.org', '\\<@matrix:%40sam%3Aexample.org>', '\\@d!123:sam', 'https://example.org/<@matrix:%40sam%3Aexample.org>', '`<@matrix:%40sam%3Aexample.org>`'])('does not render a bridged pill for literal text %s', async text => {
    const wrapper = await editorWith(text)
    expect(wrapper.findAll('.editor-bridged-mention')).toHaveLength(0)
    expect((wrapper.vm as unknown as { getPlainText: () => string }).getPlainText()).toBe(text)
  })

  it('renders @role:here as the @here pill', async () => {
    const text = '@role:here standup'
    const wrapper = await editorWith(text)

    const pills = wrapper.findAll('.editor-role-mention')
    expect(pills.map(p => p.text())).toEqual(['@here'])
    expect(pills[0].attributes('data-role-id')).toBe('here')
    expect((wrapper.vm as unknown as { getPlainText: () => string }).getPlainText()).toBe(text)
  })

  it('leaves @role:hereafter as text', async () => {
    const wrapper = await editorWith('@role:hereafter ok')
    expect(wrapper.findAll('.editor-role-mention')).toHaveLength(0)
  })
})
