/**
 * IME composition: while a composition is open the editor neither rebuilds its DOM (a
 * rebuild ends the composition and the browser commits the half-converted text) nor hands
 * keys to its parent (Enter commits the conversion; it must not send, submit or pick a
 * suggestion). The committed text is handled once, at compositionend.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
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

async function settle() {
  for (let i = 0; i < 3; i++) {
    await flushPromises()
    await nextTick()
  }
}

function setup(initial: string) {
  const wrapper = mount(RichTextEditor, { props: { modelValue: initial }, attachTo: document.body })
  const root = wrapper.find('.rich-text-editor').element as HTMLElement
  return { wrapper, root }
}

/** Appends `text` to the editor's last text node, as the browser does for a composition update. */
function typeIntoDom(root: HTMLElement, text: string) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let last: Text | null = null
  while (walker.nextNode()) last = walker.currentNode as Text
  if (last) last.data += text
  else root.appendChild(document.createTextNode(text))
}

const inputEvent = (isComposing: boolean) =>
  new InputEvent('input', { bubbles: true, isComposing, inputType: isComposing ? 'insertCompositionText' : 'insertText' })

describe('RichTextEditor IME composition', () => {
  it('keeps the composed text node through updates after a markdown marker, and draws it at compositionend', async () => {
    const { root } = setup('*x* ')
    await settle()
    typeIntoDom(root, '')
    root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    typeIntoDom(root, 'て')
    const composed = [...root.childNodes]
    root.dispatchEvent(inputEvent(true))
    typeIntoDom(root, 'す')
    root.dispatchEvent(inputEvent(true))
    await settle()
    // No rebuild while composing: the same nodes the IME is writing into.
    expect([...root.childNodes].every((node, i) => node === composed[i])).toBe(true)
    root.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'てす' }))
    await settle()
    expect(root.textContent!.replace(/\u00a0/g, ' ')).toBe('*x* てす')
  })

  it('emits the text while composing so counters follow, but no undo step until it commits', async () => {
    const { wrapper, root } = setup('')
    await settle()
    root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    typeIntoDom(root, 'に')
    root.dispatchEvent(inputEvent(true))
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['に'])
    root.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'に' }))
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['に'])
  })

  it('does not hand keys to the parent during a composition, or the committing Enter WebKit sends after it', async () => {
    const { wrapper, root } = setup('')
    await settle()
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))
    root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
    root.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'に' }))
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }))
    expect(wrapper.emitted('keydown')).toBeUndefined()
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(wrapper.emitted('keydown')).toHaveLength(1)
  })

  it('hands the parent a keyCode 229 key with no composition near (IBus, fcitx)', async () => {
    const { wrapper, root } = setup('')
    await settle()
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }))
    expect(wrapper.emitted('keydown')).toHaveLength(1)
  })
})
