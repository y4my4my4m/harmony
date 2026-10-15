/**
 * The rich editor renders markdown live and reads its text back from the DOM. Rendered text
 * reads back unchanged, and every caret offset maps to a DOM point that maps back to the
 * same offset: the caret, the selection and Ctrl+B all work in offsets of that text.
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

import { linearize, offsetForPoint, pointForOffset } from '@/utils/editorText'

interface EditorApi {
  getPlainText: () => string
  renderContent: (text: string, skipCursorRestore?: boolean) => void
}

const SAMPLES = [
  'hello',
  'a\nb',
  '**bold** text',
  '*it* and __under__ and ~~gone~~',
  'use `code` inline',
  '```\nhello world\n```',
  '```js\nconst a = 1;\nconst b = 2;\n```',
  'before\n```\nx\n```\nafter',
  '```\nfoo\n\n```',
  '> quote',
  '> a\n> b',
  '>>> line one\nline two\nline three',
  'text\n>>> quoted\nmore',
  'hi :har_wink: there',
  'a **b**\n',
  'a\n',
  'a\n\n',
  '> a\n',
  '> a\nb',
  '> a\n\nb',
  '>>> line one\n',
  '>>> one\n\nthree',
  'a\n> q',
  '>green\n',
  '```\nx\n```\nafter',
  '```\nx\n```\n',
  '```\nx\n```after',
  '```\nx\n```\n> q',
  '```\n```',
  'say ```\ncode\n``` inline',
]

async function mountWith(text: string) {
  const wrapper = mount(RichTextEditor, { props: { modelValue: text }, attachTo: document.body })
  await nextTick()
  const api = wrapper.vm as unknown as EditorApi
  api.renderContent(text, true)
  await nextTick()
  await nextTick()
  return { wrapper, api, root: wrapper.element as HTMLElement }
}

const br = () => document.createElement('br')

// Shift+Enter at the end of a block: Chrome inserts a line break and a placeholder <br>.
const CHROME_LINE_BREAKS: Array<[string, string, (root: HTMLElement) => void]> = [
  ['>>> line one', '>>> line one\n', (root) => root.querySelector('.editor-blockquote-content')!.append(br(), br())],
  ['> a', '> a\n', (root) => root.querySelector('.editor-blockquote-content')!.append(br(), br())],
  ['```\nhello\n```', '```\nhello\n\n```', (root) => root.querySelector('.editor-codeblock-content')!.append(br(), br())],
  ['plain', 'plain\n', (root) => root.append(br(), br())],
  ['**b**', '**b**\n', (root) => root.append(br(), br())],
]

describe('RichTextEditor text round trip', () => {
  it.each(CHROME_LINE_BREAKS)('%j with a browser line break reads back as %j', async (text, expected, mutate) => {
    const { api, root } = await mountWith(text)
    mutate(root)
    expect(api.getPlainText()).toBe(expected)
    const lin = linearize(root)
    const end = pointForOffset(lin, root, expected.length)
    expect(offsetForPoint(lin, root, end.node, end.offset)).toBe(expected.length)
    // Re-rendered, the text and the caret's empty last line survive.
    api.renderContent(expected, true)
    expect(api.getPlainText()).toBe(expected)
    const relin = linearize(root)
    const caret = pointForOffset(relin, root, expected.length)
    expect(offsetForPoint(relin, root, caret.node, caret.offset)).toBe(expected.length)
  })

  it.each(SAMPLES)('%j reads back as typed', async (text) => {
    const { api } = await mountWith(text)
    expect(api.getPlainText()).toBe(text)
  })

  it.each(SAMPLES)('every offset of %j maps to a point and back', async (text) => {
    const { root } = await mountWith(text)
    const lin = linearize(root)
    // A pill is one caret stop: offsets inside its text have no DOM point of their own.
    const insidePill = (p: number) => lin.units.some((u) => u.kind === 'atom' && u.length > 1 && u.start < p && p < u.start + u.length)
    for (let p = 0; p <= lin.text.length; p++) {
      if (insidePill(p)) continue
      const point = pointForOffset(lin, root, p)
      expect(offsetForPoint(lin, root, point.node, point.offset), `offset ${p}`).toBe(p)
    }
  })
})
