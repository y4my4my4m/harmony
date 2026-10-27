/**
 * Composer behaviour of RichTextEditor:
 * - an open IME composition is not re-rendered under the input method; the render waits for
 *   compositionend;
 * - rendered text keeps ordinary spaces between words, so lines wrap between words;
 * - the editor takes its direction from its text (dir="auto");
 * - [label](url) shows as a masked link and reads back as typed;
 * - a URL pasted over selected text links the text to it.
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

interface EditorApi {
  getPlainText: () => string
  setCursorPosition: (n: number) => void
}

async function editorWith(text: string) {
  const wrapper = mount(RichTextEditor, { props: { modelValue: text }, attachTo: document.body })
  await nextTick()
  const el = wrapper.element as HTMLElement
  el.focus()
  return { wrapper, el, api: wrapper.vm as unknown as EditorApi }
}

function selectText(el: HTMLElement, from: number, to: number) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let offset = 0
  let start: [Node, number] | null = null
  let end: [Node, number] | null = null
  let node: Node | null
  while ((node = walker.nextNode())) {
    const len = (node as Text).data.length
    if (!start && from <= offset + len) start = [node, from - offset]
    if (!end && to <= offset + len) end = [node, to - offset]
    offset += len
  }
  const range = document.createRange()
  range.setStart(...start!)
  range.setEnd(...end!)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

function paste(el: HTMLElement, text: string) {
  const store: Record<string, string> = { 'text/plain': text }
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (t: string) => store[t] ?? '', items: [{ kind: 'string', type: 'text/plain' }] },
  })
  el.dispatchEvent(event)
}

const settle = async () => {
  await nextTick()
  await nextTick()
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

describe('RichTextEditor composition', () => {
  it('leaves the DOM alone while a composition is open, then renders', async () => {
    const { el, api, wrapper } = await editorWith('**a** ')
    const bold = el.querySelector('.editor-bold-wrapper')
    expect(bold).not.toBeNull()

    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
    el.appendChild(document.createTextNode('にほ'))
    el.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', isComposing: true, bubbles: true }))
    await settle()
    // The same element: nothing was rebuilt under the composition.
    expect(el.querySelector('.editor-bold-wrapper')).toBe(bold)
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['**a** にほ'])

    el.dispatchEvent(new CompositionEvent('compositionend', { data: 'にほ' }))
    await settle()
    expect(el.querySelector('.editor-bold-wrapper')).not.toBe(bold)
    expect(api.getPlainText()).toBe('**a** にほ')
  })
})

describe('RichTextEditor rendering', () => {
  it('keeps ordinary spaces between words after a render', async () => {
    const { el } = await editorWith('*a* one two  three ')
    const text = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => (n as Text).data).join('|')
    expect(text).toBe('\u00a0one two\u00a0 three\u00a0')
  })

  it('takes its direction from its text', async () => {
    const { el } = await editorWith('')
    expect(el.getAttribute('dir')).toBe('auto')
  })

  it('shows a masked link with its label and reads back as typed', async () => {
    const typed = 'see [the docs](https://example.com/a_(b)) now'
    const { el, api } = await editorWith(typed)
    expect(el.querySelector('.editor-link-label')?.textContent).toBe('the docs')
    expect(el.querySelector('.editor-link-url')?.textContent).toBe('https://example.com/a_(b)')
    expect(api.getPlainText()).toBe(typed)
  })
})

describe('RichTextEditor paste over a selection', () => {
  it('links the selected text to a pasted URL', async () => {
    const { el, api, wrapper } = await editorWith('read the docs please')
    selectText(el, 5, 13)
    paste(el, ' https://example.com/docs\n')
    await settle()
    expect(api.getPlainText()).toBe('read [the docs](https://example.com/docs) please')
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['read [the docs](https://example.com/docs) please'])
  })

  it('replaces the selection with pasted text that is not one URL', async () => {
    const { el, api } = await editorWith('read the docs please')
    selectText(el, 5, 13)
    paste(el, 'see https://example.com')
    await settle()
    expect(api.getPlainText()).toBe('read see https://example.com please')
  })

  it('replaces a selected URL with the pasted one', async () => {
    const { el, api } = await editorWith('go https://old.example now')
    selectText(el, 3, 22)
    paste(el, 'https://new.example')
    await settle()
    expect(api.getPlainText()).toBe('go https://new.example now')
  })
})
