/**
 * The rich editor (main composer, thread composer, message edit box, post
 * composer) copies custom emoji as tokens and resolves pasted tokens back to
 * emoji; pasted HTML is reduced to text.
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
vi.mock('@/services/emojiShortcodeResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/emojiShortcodeResolver')>()
  return {
    ...actual,
    findEmojiByName: (name: string) =>
      name === 'har_wink' ? { id: 'e1', name: 'har_wink', url: 'https://cdn.example/har_wink.webp' } : actual.findEmojiByName(name),
  }
})

import RichTextEditor from '../RichTextEditor.vue'

enableAutoUnmount(afterEach)

const ID = '1376980620600672316'

interface EditorApi {
  getPlainText: () => string
  setCursorPosition: (n: number) => void
}

function clipboard(initial: Record<string, string> = {}, files = false) {
  const store: Record<string, string> = { ...initial }
  return {
    store,
    getData: (type: string) => store[type] ?? '',
    setData: (type: string, value: string) => { store[type] = value },
    items: files ? [{ kind: 'file', type: 'image/png' }] : [{ kind: 'string', type: 'text/plain' }],
  }
}

function clipboardEvent(type: 'paste' | 'copy' | 'cut', data: ReturnType<typeof clipboard>) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', { value: data })
  return event
}

async function editorWith(text: string) {
  const wrapper = mount(RichTextEditor, { props: { modelValue: text }, attachTo: document.body })
  await nextTick()
  const el = wrapper.element as HTMLElement
  el.focus()
  return { wrapper, el, api: wrapper.vm as unknown as EditorApi }
}

async function pasteInto(text: string, data: ReturnType<typeof clipboard>) {
  const editor = await editorWith(text)
  editor.api.setCursorPosition(text.length)
  editor.el.dispatchEvent(clipboardEvent('paste', data))
  await nextTick()
  await nextTick()
  return editor
}

function selectAll(el: HTMLElement) {
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

describe('RichTextEditor paste', () => {
  it('resolves pasted tokens to emoji images', async () => {
    const { el, api } = await pasteInto('hi ', clipboard({ 'text/plain': `:har_wink: and :discord:heh:${ID}:` }))
    const srcs = Array.from(el.querySelectorAll('.editor-emoji img')).map((img) => img.getAttribute('src'))
    expect(srcs).toHaveLength(2)
    expect(srcs[0]).toContain('har_wink')
    expect(srcs[1]).toBe(`https://cdn.discordapp.com/emojis/${ID}.png`)
    expect(api.getPlainText()).toBe(`hi :har_wink: and :discord:heh:${ID}:`)
  })

  it('resolves emoji images in pasted HTML whose text/plain lost them', async () => {
    const data = clipboard({
      'text/plain': 'look  there',
      'text/html': `<span>look <img class="emoji-icon" alt=":heh:" data-emoji-token=":discord:heh:${ID}:" src="x.png"> there</span>`,
    })
    const { el, api } = await pasteInto('', data)
    expect(el.querySelectorAll('.editor-emoji img')).toHaveLength(1)
    expect(api.getPlainText()).toBe(`look :discord:heh:${ID}: there`)
  })

  it('grows to fit a pasted wall of text and scrolls past maxHeight', async () => {
    const editor = await editorWith('')
    Object.defineProperty(editor.el, 'scrollHeight', { configurable: true, get: () => 300 })
    editor.api.setCursorPosition(0)
    editor.el.dispatchEvent(clipboardEvent('paste', clipboard({ 'text/plain': 'line\n'.repeat(40) })))
    await nextTick()
    await nextTick()
    expect(editor.el.style.height).toBe('200px')
    expect(editor.el.style.overflowY).toBe('auto')
    expect(editor.el.scrollTop).toBe(300)
  })

  it('inserts plain text unchanged', async () => {
    const { el, wrapper } = await pasteInto('a', clipboard({ 'text/plain': ' plain: text, no emoji' }))
    expect(el.querySelectorAll('.editor-emoji')).toHaveLength(0)
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['a plain: text, no emoji'])
  })

  it('inserts malicious HTML as text only', async () => {
    const data = clipboard({
      'text/plain': '',
      'text/html': '<img alt=":har_wink:" src="x" onerror="alert(1)"><script>alert(2)</script><b onclick="alert(3)">bold</b>',
    })
    const { el, api } = await pasteInto('', data)
    expect(el.querySelector('script, b, [onerror], [onclick]')).toBeNull()
    expect(el.querySelectorAll('img')).toHaveLength(1)
    expect(el.querySelector('img')!.getAttribute('src')).toContain('har_wink')
    expect(api.getPlainText()).toBe(':har_wink:bold')
  })

  it('hands file pastes to the parent', async () => {
    const { wrapper, el } = await editorWith('')
    el.dispatchEvent(clipboardEvent('paste', clipboard({}, true)))
    expect(wrapper.emitted('paste')).toHaveLength(1)
  })
})

describe('RichTextEditor copy and cut', () => {
  it('copies the selection as tokens with an HTML form', async () => {
    const text = `a :har_wink: b :discord:heh:${ID}:`
    const { el } = await editorWith(text)
    selectAll(el)
    const data = clipboard()
    const event = clipboardEvent('copy', data)
    el.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(data.store['text/plain']).toBe(text)
    expect(data.store['text/html']).toContain('data-emoji-token=":har_wink:"')
    expect(data.store['text/html']).toContain(`data-emoji-token=":discord:heh:${ID}:"`)
  })

  it('leaves a copy without emoji to the browser', async () => {
    const { el } = await editorWith('plain words')
    selectAll(el)
    const data = clipboard()
    const event = clipboardEvent('copy', data)
    el.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(data.store['text/plain']).toBeUndefined()
  })

  it('round-trips a copy into another editor', async () => {
    const source = await editorWith('x :har_wink: y')
    selectAll(source.el)
    const data = clipboard()
    source.el.dispatchEvent(clipboardEvent('copy', data))

    const target = await pasteInto('', clipboard(data.store))
    expect(target.el.querySelectorAll('.editor-emoji img')).toHaveLength(1)
    expect(target.api.getPlainText()).toBe('x :har_wink: y')
  })

  it('cut writes the tokens and removes the selection', async () => {
    const { el, wrapper } = await editorWith('a :har_wink:')
    selectAll(el)
    const data = clipboard()
    el.dispatchEvent(clipboardEvent('cut', data))
    expect(data.store['text/plain']).toBe('a :har_wink:')
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([''])
  })
})
