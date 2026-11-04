/**
 * Under the Twemoji pack the rich editor draws each unicode emoji sequence Twemoji has a file
 * for as a non-editable atom over its image; the atom keeps the characters as its text. The
 * text reads back byte for byte, offsets round-trip at atom boundaries, a copy holds the
 * characters, and an emoji typed into a text node is drawn on input. Under the System pack, and
 * inside fenced code, the characters stay text.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'

const pack = ref<'twemoji' | 'native'>('twemoji')

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
  userDataService: {
    findUserIdByUsername: (name: string) => (name === 'alice' ? 'u1' : null),
    getUserProfile: () => ({ is_local: true }),
  },
}))
vi.mock('@/services/unifiedEmojiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/unifiedEmojiService')>()
  const { computed } = await import('vue')
  // Twemoji files of the sequences used here; 🆕 stands for a sequence Twemoji has no file for.
  const files: Record<string, string> = {
    '😀': '1f600', '👍🏽': '1f44d-1f3fd', '👨‍👩‍👧': '1f468-200d-1f469-200d-1f467', '🇯🇵': '1f1ef-1f1f5',
    '1️⃣': '31-20e3', '🏴󠁧󠁢󠁥󠁮󠁧󠁿': '1f3f4-e0067-e0062-e0065-e006e-e0067-e007f', '❤️': '2764', '🔥': '1f525',
  }
  return {
    ...actual,
    useUnifiedEmoji: () => ({ isLoaded: ref(true) }),
    currentPack: computed(() => pack.value),
    twemojiFileUrl: (unicode: string) =>
      pack.value === 'twemoji' && files[unicode] ? `/assets/emojis/twemoji/${files[unicode]}.svg` : null,
    loadEmojiData: vi.fn(async () => {}),
  }
})

import RichTextEditor from '../RichTextEditor.vue'
import { linearize, offsetForPoint, pointForOffset } from '@/utils/editorText'

enableAutoUnmount(afterEach)
beforeEach(() => {
  pack.value = 'twemoji'
})

interface EditorApi {
  getPlainText: () => string
  renderContent: (text: string, skipCursorRestore?: boolean) => void
  setCursorPosition: (n: number) => void
}

const SKIN = '👍🏽'
const FAMILY = '👨‍👩‍👧'
const FLAG = '🇯🇵'
const KEYCAP = '1️⃣'
const ENGLAND = '🏴󠁧󠁢󠁥󠁮󠁧󠁿'

async function mountWith(text: string) {
  const wrapper = mount(RichTextEditor, { props: { modelValue: text }, attachTo: document.body })
  await nextTick()
  const api = wrapper.vm as unknown as EditorApi
  api.renderContent(text, true)
  await nextTick()
  await nextTick()
  return { wrapper, api, root: wrapper.element as HTMLElement }
}

const atoms = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>('.editor-twemoji')).map((el) => ({
    unicode: el.dataset.unicode,
    text: el.textContent,
    image: el.style.backgroundImage,
    editable: el.getAttribute('contenteditable'),
  }))

const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex')

const SAMPLES: Array<[string, string[]]> = [
  [`hi ${SKIN} there`, [SKIN]],
  [`${FAMILY}${SKIN}${FLAG}${KEYCAP}${ENGLAND}`, [FAMILY, SKIN, FLAG, KEYCAP, ENGLAND]],
  [`a  ${'😀'}  b`, ['😀']],
  [`**bold ${SKIN}** and *it ${FLAG}*`, [SKIN, FLAG]],
  [`\`code ${'🔥'}\``, ['🔥']],
  [`\`\`\`\nfenced ${'🔥'}\n\`\`\``, []],
  [`[label ${'😀'}](https://example.com)`, ['😀']],
  [`> quoted ${FLAG}\nafter ${SKIN}`, [FLAG, SKIN]],
  [`@alice ${'😀'}@alice`, ['😀']],
  [`line ${'❤️'}\n\n${'😀'}`, ['❤️', '😀']],
  // No Twemoji file: stays text.
  ['new 🆕 one', []],
  // Text presentation: stays text.
  ['™ ❤ ☺', []],
]

describe('RichTextEditor Twemoji', () => {
  it.each(SAMPLES)('%j draws %j and reads back byte for byte', async (text, drawn) => {
    const { api, root } = await mountWith(text)
    expect(atoms(root).map((a) => a.unicode)).toEqual(drawn)
    for (const atom of atoms(root)) {
      expect(atom.text).toBe(atom.unicode)
      expect(atom.editable).toBe('false')
      expect(atom.image).toMatch(/^url\("\/assets\/emojis\/twemoji\/[0-9a-f-]+\.svg"\)$/)
    }
    expect(hex(api.getPlainText())).toBe(hex(text))
  })

  it.each(SAMPLES)('every offset of %j outside an emoji maps to a point and back', async (text) => {
    const { root } = await mountWith(text)
    const lin = linearize(root)
    const inside = (p: number) => lin.units.some((u) => u.kind === 'atom' && u.length > 1 && u.start < p && p < u.start + u.length)
    for (let p = 0; p <= lin.text.length; p++) {
      if (inside(p)) continue
      const point = pointForOffset(lin, root, p)
      expect(offsetForPoint(lin, root, point.node, point.offset), `offset ${p}`).toBe(p)
    }
  })

  it('fenced code keeps its emoji as text', async () => {
    const { root } = await mountWith('```\n😀\n```')
    expect(root.querySelector('.editor-codeblock-content')?.textContent).toContain('😀')
    expect(atoms(root)).toEqual([])
  })

  it('under the System pack every emoji stays text', async () => {
    pack.value = 'native'
    const text = `hi ${SKIN} ${FAMILY}`
    const { api, root } = await mountWith(text)
    expect(atoms(root)).toEqual([])
    expect(root.textContent?.replace(/\u00a0/g, ' ')).toBe(text)
    expect(api.getPlainText()).toBe(text)
  })

  it('a pack switch redraws the draft, text unchanged', async () => {
    const text = `x ${SKIN} y`
    const { api, root } = await mountWith(text)
    expect(atoms(root)).toHaveLength(1)
    pack.value = 'native'
    await nextTick()
    await nextTick()
    expect(atoms(root)).toEqual([])
    expect(api.getPlainText()).toBe(text)
    pack.value = 'twemoji'
    await nextTick()
    await nextTick()
    expect(atoms(root).map((a) => a.unicode)).toEqual([SKIN])
    expect(api.getPlainText()).toBe(text)
  })

  it('an emoji typed into a text node is drawn on input and emitted unchanged', async () => {
    const { wrapper, root } = await mountWith('ab')
    const textNode = root.firstChild as Text
    textNode.data = `a${FLAG}b`
    const selection = window.getSelection()!
    selection.collapse(textNode, 1 + FLAG.length)
    root.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: FLAG }))
    await nextTick()
    await nextTick()
    expect(atoms(root).map((a) => a.unicode)).toEqual([FLAG])
    const emitted = wrapper.emitted('update:modelValue') as string[][]
    expect(hex(emitted.at(-1)![0])).toBe(hex(`a${FLAG}b`))
  })

  it('an input during a composition draws nothing until it ends', async () => {
    const { root } = await mountWith('ab')
    root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    ;(root.firstChild as Text).data = 'a😀b'
    root.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', isComposing: true }))
    await nextTick()
    expect(atoms(root)).toEqual([])
    root.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '😀' }))
    await new Promise((r) => setTimeout(r, 0))
    await nextTick()
    expect(atoms(root).map((a) => a.unicode)).toEqual(['😀'])
  })

  it('a deletion aimed inside an emoji, as Gboard sends it, removes the emoji whole', async () => {
    const { wrapper, root } = await mountWith(`hi ${SKIN} yes`)
    const inner = root.querySelector('.editor-twemoji')!.firstChild as Text
    const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward' })
    Object.defineProperty(event, 'getTargetRanges', {
      value: () => [{ startContainer: inner, startOffset: 0, endContainer: inner, endOffset: inner.length, collapsed: false }],
    })
    root.dispatchEvent(event)
    await nextTick()
    await nextTick()
    expect(event.defaultPrevented).toBe(true)
    expect(atoms(root)).toEqual([])
    const emitted = wrapper.emitted('update:modelValue') as string[][]
    expect(emitted.at(-1)![0]).toBe('hi  yes')
  })

  it('a deletion outside any emoji is left to the browser', async () => {
    const { root } = await mountWith(`hi ${SKIN} yes`)
    const text = root.lastChild as Text
    const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward' })
    Object.defineProperty(event, 'getTargetRanges', {
      value: () => [{ startContainer: text, startOffset: 3, endContainer: text, endOffset: 4, collapsed: false }],
    })
    root.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(atoms(root)).toHaveLength(1)
  })

  it('a copy of a selection over emoji holds their characters', async () => {
    const text = `a ${SKIN}${FAMILY} b`
    const { root } = await mountWith(text)
    root.focus()
    const range = document.createRange()
    range.selectNodeContents(root)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    const store: Record<string, string> = {}
    const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', {
      value: { setData: (type: string, value: string) => { store[type] = value }, getData: (type: string) => store[type] ?? '' },
    })
    root.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(hex(store['text/plain'])).toBe(hex(text))
    expect(store['text/html']).toContain(SKIN)
  })
})
