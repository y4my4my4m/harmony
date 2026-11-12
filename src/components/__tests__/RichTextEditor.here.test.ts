/**
 * The composer editor shows @role:here as an @here pill and gives the token back as its plain
 * text, as it does @role:UUID.
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
  it('shows readable Matrix identities while preserving source tokens for sends and edits', async () => {
    const token = '<@matrix:%40sam%3Aexample.org%3A8448>'
    const text = `hello ${token} there`
    const wrapper = await editorWith(text)
    const pill = wrapper.get('.editor-mention')
    expect(pill.text()).toBe('@sam:example.org:8448')
    expect(pill.attributes('data-display-text')).toBe(token)
    expect((wrapper.vm as unknown as { getPlainText: () => string }).getPlainText()).toBe(text)
  })

  it.each(['<@matrix:%ZZ>', '<@matrix:%40sam%3Aexample.org', '\\<@matrix:%40sam%3Aexample.org>', 'https://example.org/<@matrix:%40sam%3Aexample.org>', '`<@matrix:%40sam%3Aexample.org>`'])('does not render a Matrix pill for literal text %s', async text => {
    const wrapper = await editorWith(text)
    expect(wrapper.findAll('.editor-mention').filter(pill => pill.attributes('title')?.startsWith('Matrix:'))).toHaveLength(0)
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
