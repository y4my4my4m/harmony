/**
 * A value the parent sets after mount and then places the caret in (Composer.vue's reply
 * mentions) is rendered once, by the modelValue watcher. The editor's mount render, which
 * waits for the current server's roles, does not render it again: that render restored the
 * caret it read before the parent placed it, in front of the mentions (Chrome, opened from a
 * server channel with the roles cached).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, onMounted, ref } from 'vue'

let releaseRoles: () => void = () => {}

vi.mock('@/composables/useViewport', () => ({
  useViewport: () => ({ isMobileViewport: ref(false), isTouchOnly: false }),
}))
vi.mock('@/composables/useVisualTheme', () => ({
  useVisualTheme: () => ({ currentSettings: ref({ greentextEnabled: true }) }),
}))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ currentServerId: 'server-1' }),
}))
vi.mock('@/services/RoleService', () => ({
  roleService: {
    getRolesForServer: vi.fn(() => new Promise((resolve) => { releaseRoles = () => resolve([]) })),
    getRole: vi.fn(async () => null),
  },
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

type Editor = { focus: () => void; setCursorPosition: (n: number) => void }

const PREFILL = '@alice@remote.example @bob '

// Composer.vue's reply mount: set the mentions, focus, then put the caret after them.
const ReplyComposer = defineComponent(() => {
  const content = ref('')
  const editor = ref<Editor>()
  onMounted(() => {
    content.value = PREFILL
    nextTick(() => {
      editor.value?.focus()
      nextTick(() => editor.value?.setCursorPosition(content.value.length))
    })
  })
  return () => h(RichTextEditor, {
    ref: editor,
    modelValue: content.value,
    'onUpdate:modelValue': (v: string) => { content.value = v },
  })
})

async function settle() {
  for (let i = 0; i < 5; i++) {
    await flushPromises()
    await nextTick()
  }
}

function textBeforeCaret(root: HTMLElement): string | null {
  const selection = getSelection()
  if (!selection?.rangeCount || !root.contains(selection.anchorNode)) return null
  const range = document.createRange()
  range.setStart(root, 0)
  range.setEnd(selection.anchorNode!, selection.anchorOffset)
  return range.toString().replace(/\u00a0/g, ' ')
}

describe('RichTextEditor in a reply', () => {
  it('renders the prefilled mentions once and keeps the caret after them when the roles arrive', async () => {
    const wrapper = mount(ReplyComposer, { attachTo: document.body })
    await settle()
    const root = wrapper.find('.rich-text-editor').element as HTMLElement
    const rendered = [...root.childNodes]
    expect(textBeforeCaret(root)).toBe(PREFILL)

    releaseRoles()
    await settle()
    // The same nodes, not a re-render of the same text.
    expect([...root.childNodes].every((node, i) => node === rendered[i])).toBe(true)
    expect(root.textContent!.replace(/\u00a0/g, ' ')).toBe(PREFILL)
    expect(textBeforeCaret(root)).toBe(PREFILL)
  })

  it('still renders a value it was mounted with once the roles arrive', async () => {
    const wrapper = mount(RichTextEditor, { props: { modelValue: 'draft @bob kept' }, attachTo: document.body })
    await settle()
    const root = wrapper.find('.rich-text-editor').element as HTMLElement
    expect(root.textContent).toBe('')

    releaseRoles()
    await settle()
    expect(root.textContent!.replace(/\u00a0/g, ' ')).toBe('draft @bob kept')
  })
})
