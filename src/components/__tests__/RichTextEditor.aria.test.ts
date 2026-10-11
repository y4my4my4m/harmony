/**
 * The composer is a multi-line textbox with an autocomplete listbox. role=textbox
 * takes no aria-expanded (axe aria-allowed-attr); the open list shows as
 * aria-controls and aria-activedescendant, both absent while it is closed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { ref } from 'vue'

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

describe('RichTextEditor ARIA', () => {
  it('is a labelled multi-line textbox without aria-expanded', () => {
    const w = mount(RichTextEditor, { props: { modelValue: '', placeholder: 'Message #general' } })
    const el = w.get('.rich-text-editor')
    expect(el.attributes('role')).toBe('textbox')
    expect(el.attributes('aria-multiline')).toBe('true')
    expect(el.attributes('aria-label')).toBe('Message #general')
    expect(el.attributes('aria-autocomplete')).toBe('list')
    expect(el.attributes('aria-expanded')).toBeUndefined()
    expect(el.attributes('aria-controls')).toBeUndefined()
    expect(el.attributes('aria-activedescendant')).toBeUndefined()
  })

  it('names the listbox and its selected option while suggestions show', async () => {
    const w = mount(RichTextEditor, { props: { modelValue: ':th', autoSuggestActive: true, autoSuggestSelectedId: 'suggest-2' } })
    const el = w.get('.rich-text-editor')
    expect(el.attributes('aria-controls')).toBe('auto-suggest-listbox')
    expect(el.attributes('aria-activedescendant')).toBe('suggest-2')
    expect(el.attributes('aria-expanded')).toBeUndefined()
    await w.setProps({ autoSuggestActive: false })
    expect(el.attributes('aria-controls')).toBeUndefined()
    expect(el.attributes('aria-activedescendant')).toBeUndefined()
  })
})
