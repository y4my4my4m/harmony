/**
 * The inline message edit box offers the composer's emoji suggestions: the
 * popup opens on every `:xx`, including in text the editor re-renders for
 * markdown, sits outside the message row (teleported, anchored to the
 * caret), and Escape closes it without cancelling the edit.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { enableAutoUnmount, mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, ref } from 'vue'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
}))
vi.mock('@/utils/avatarUtils', () => ({
  getAvatarUrl: vi.fn((url: string | null) => url || '/default_avatar.webp'),
}))
vi.mock('@/composables/useViewport', () => ({
  useViewport: () => ({ isMobileViewport: ref(false), isTouchOnly: false }),
}))
vi.mock('@/stores/useEmojiCache', () => ({
  PERSONAL_EMOJI_GROUPS: { ai: '__ai_generated__', user: '__user_emoji__', instance: '__instance_emoji__' },
  useEmojiCacheStore: () => ({
    isInitialized: false,
    resolvedEmojis: {
      s1: {
        server_name: 'Server',
        emojis: [{ id: 'e1', name: 'har_wink', display_name: 'har_wink', url: 'https://cdn.example/har_wink.webp' }],
      },
    },
    serverCaches: new Map(),
    nameIndex: new Map(),
    getEmojiById: () => null,
  }),
}))
vi.mock('@/composables/useEmojiLoader', () => ({ ensureEmojiDataLoaded: vi.fn() }))
vi.mock('@/composables/useFrequentEmojis', () => ({
  useFrequentEmojis: () => ({ frequentEmojis: ref([]) }),
}))
vi.mock('@/services/emojiShortcodeResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/emojiShortcodeResolver')>()
  return {
    ...actual,
    findEmojiByName: (name: string) =>
      name === 'har_wink' ? { id: 'e1', name: 'har_wink', url: 'https://cdn.example/har_wink.webp' } : actual.findEmojiByName(name),
  }
})

import UnifiedMessageContent from '@/components/UnifiedMessageContent.vue'

enableAutoUnmount(afterEach)

const originalRects = (Range.prototype as unknown as { getClientRects?: unknown }).getClientRects

beforeEach(() => {
  setActivePinia(createPinia())
  ;(Range.prototype as unknown as { getClientRects: () => DOMRect[] }).getClientRects = () => [
    { left: 220, top: 300, bottom: 318, right: 221, width: 1, height: 18, x: 220, y: 300, toJSON: () => ({}) } as DOMRect,
  ]
})
afterEach(() => {
  ;(Range.prototype as unknown as { getClientRects?: unknown }).getClientRects = originalRects
  document.body.innerHTML = ''
})

async function editing(initial: string) {
  const wrapper = mount(UnifiedMessageContent, {
    props: {
      content: [{ type: 'text', text: initial }],
      messageId: 'm1',
      editableMessageId: 'm1',
      editableContent: initial,
    },
    attachTo: document.body,
    global: { mocks: { $t: (key: string) => key } },
  })
  await flushPromises()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const editor = wrapper.element.querySelector('.rich-text-editor') as HTMLElement
  return { wrapper, editor }
}

// Appends `typed` at the end of the editor text, places the caret after it,
// and fires the input event a keystroke produces. `rerendered` models a
// browser re-render of formatted text: clearing the editor DOM moves the
// selection to the editor start until the editor restores the caret.
async function type(editor: HTMLElement, typed: string, rerendered = false) {
  editor.appendChild(document.createTextNode(typed))
  const last = editor.lastChild!
  const range = document.createRange()
  range.setStart(last, last.textContent!.length)
  range.collapse(true)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  editor.dispatchEvent(new Event('input', { bubbles: true }))
  if (rerendered) {
    const start = document.createRange()
    start.setStart(editor, 0)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(start)
  }
  await nextTick()
  await nextTick()
}

function key(editor: HTMLElement, name: string) {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
  editor.dispatchEvent(event)
  return event
}

const popup = () => document.body.querySelector<HTMLElement>('.auto-suggest')

describe('message edit box emoji suggestions', () => {
  it('shows suggestions for :xx outside the message row, anchored to the caret', async () => {
    const { wrapper, editor } = await editing('fix this')
    await type(editor, ' :har')

    const list = popup()
    expect(list).not.toBeNull()
    expect(list!.textContent).toContain(':har_wink:')
    // Teleported: not a descendant of the (transformed, virtualized) row.
    expect(wrapper.element.contains(list)).toBe(false)
    expect(list!.parentElement).toBe(document.body)
    expect(list!.style.position).toBe('fixed')
    // Below the caret line (bottom 318 + 4 px gap), x 12 px left of the caret.
    expect(list!.style.top).toBe('322px')
    expect(list!.style.left).toBe('208px')
  })

  it('shows suggestions in text the editor re-renders for markdown', async () => {
    const { editor } = await editing('see *this* and some_thing')
    await type(editor, ' :har', true)
    expect(popup()?.textContent).toContain(':har_wink:')
  })

  it('inserts the picked emoji with Enter and keeps the edit open', async () => {
    const { wrapper, editor } = await editing('fix')
    await type(editor, ' :har')
    const enter = key(editor, 'Enter')
    expect(enter.defaultPrevented).toBe(true)
    await flushPromises()

    const updates = wrapper.emitted('update:content')!
    expect(updates.at(-1)).toEqual(['fix :har_wink: '])
    expect(wrapper.emitted('update:message')).toBeUndefined()
    expect(popup()).toBeNull()
  })

  it('moves the selection with arrow keys and inserts with Tab', async () => {
    const { wrapper, editor } = await editing('x')
    await type(editor, ' :')
    const items = () => Array.from(popup()!.querySelectorAll('.suggest-item'))
    expect(items().length).toBeGreaterThan(0)
    key(editor, 'ArrowDown')
    key(editor, 'ArrowUp')
    key(editor, 'Tab')
    await flushPromises()
    expect(wrapper.emitted('update:content')!.at(-1)).toEqual(['x :har_wink: '])
  })

  it('Escape closes the popup without cancelling the edit; a second Escape cancels', async () => {
    const { wrapper, editor } = await editing('fix')
    await type(editor, ' :har')
    expect(popup()).not.toBeNull()

    const first = key(editor, 'Escape')
    await nextTick()
    expect(first.defaultPrevented).toBe(true)
    expect(popup()).toBeNull()
    expect(wrapper.emitted('cancel-edit')).toBeUndefined()

    key(editor, 'Escape')
    expect(wrapper.emitted('cancel-edit')).toHaveLength(1)
  })
})
