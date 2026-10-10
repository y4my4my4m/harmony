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

describe('RichTextEditor with @here', () => {
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
