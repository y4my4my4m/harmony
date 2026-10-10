/**
 * The composer's plain text keeps a mention pill a handle of its own: whatever DOM the
 * browser leaves around the pill, the text after it does not extend its host and the
 * text before it does not void it. Stored posts held hosts with the next word glued on
 * (spacify.cloudit, mastodon.gamedev.placeThis).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { findHandles } from '@/utils/mentionGrammar'

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

type Editor = { getPlainText: () => string }

const pill = (handle: string) =>
  `<span class="editor-mention" contenteditable="false" data-display-text="${handle}">${handle}</span>`

/** Plain text of an editor whose DOM is `html`, as the browser left it. */
async function plainTextOf(build: (root: HTMLElement) => void) {
  const wrapper = mount(RichTextEditor, { props: { modelValue: '' }, attachTo: document.body })
  await nextTick()
  const root = wrapper.find('[contenteditable="true"]').element as HTMLElement
  build(root)
  return (wrapper.vm as unknown as Editor).getPlainText()
}

const hosts = (text: string) => findHandles(text).map((h) => `${h.username}@${h.domain}`)

describe('RichTextEditor plain text around mention pills', () => {
  it('separates a word typed into a fresh text node after an empty one', async () => {
    const text = await plainTextOf((root) => {
      root.innerHTML = pill('@kai@spacify.cloud')
      root.appendChild(document.createTextNode(''))
      root.appendChild(document.createTextNode('it works'))
    })
    expect(text).toBe('@kai@spacify.cloud it works')
    expect(hosts(text)).toEqual(['kai@spacify.cloud'])
  })

  it('keeps the line break of a new block after the pill', async () => {
    const text = await plainTextOf((root) => {
      root.innerHTML = `${pill('@nyx@mastodon.gamedev.place')}<div>This is it</div>`
    })
    expect(text).toBe('@nyx@mastodon.gamedev.place\nThis is it')
    expect(hosts(text)).toEqual(['nyx@mastodon.gamedev.place'])
  })

  it('keeps the line break of a <br> after the pill', async () => {
    const text = await plainTextOf((root) => {
      root.innerHTML = `${pill('@nyx@mastodon.gamedev.place')}<br>This`
    })
    expect(text).toBe('@nyx@mastodon.gamedev.place\nThis')
    expect(hosts(text)).toEqual(['nyx@mastodon.gamedev.place'])
  })

  it('separates text the browser wrapped in an inline element', async () => {
    const text = await plainTextOf((root) => {
      root.innerHTML = `${pill('@kai@spacify.cloud')}<span style="font-weight: 400;">it</span>`
    })
    expect(text).toBe('@kai@spacify.cloud it')
    expect(hosts(text)).toEqual(['kai@spacify.cloud'])
  })

  it('separates two adjacent pills', async () => {
    const text = await plainTextOf((root) => {
      root.innerHTML = pill('@kai@spacify.cloud') + pill('@hby@misskey.io')
    })
    expect(text).toBe('@kai@spacify.cloud @hby@misskey.io')
    expect(hosts(text)).toEqual(['kai@spacify.cloud', 'hby@misskey.io'])
  })

  it('separates a pill from the word before it', async () => {
    const text = await plainTextOf((root) => {
      root.innerHTML = `hello${pill('@hby@misskey.io')}`
    })
    expect(text).toBe('hello @hby@misskey.io')
    expect(hosts(text)).toEqual(['hby@misskey.io'])
  })

  it('adds nothing before punctuation or after a space', async () => {
    const text = await plainTextOf((root) => {
      root.innerHTML = `hi ${pill('@kai@spacify.cloud')}, and ${pill('@hby@misskey.io')}.`
    })
    expect(text).toBe('hi @kai@spacify.cloud, and @hby@misskey.io.')
    expect(hosts(text)).toEqual(['kai@spacify.cloud', 'hby@misskey.io'])
  })

  it('renders typed text with a mention and a new line back unchanged', async () => {
    const wrapper = mount(RichTextEditor, {
      props: { modelValue: '@nyx@mastodon.gamedev.place\nThis is it' },
      attachTo: document.body,
    })
    await nextTick()
    const text = (wrapper.vm as unknown as Editor).getPlainText()
    expect(text).toBe('@nyx@mastodon.gamedev.place\nThis is it')
    expect(hosts(text)).toEqual(['nyx@mastodon.gamedev.place'])
  })
})
