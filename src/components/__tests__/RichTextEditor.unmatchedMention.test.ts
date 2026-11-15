/**
 * The composer draws a typed local @handle as a pill until a lookup finds no account under
 * that exact username; then it is the text typed, as the send path stores it.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'

const lookup = vi.hoisted(() => ({
  answers: new Map<string, boolean>(),
  requested: [] as string[],
  count: null as unknown as { value: number },
}))

vi.mock('@/utils/localHandleLookup', async () => {
  const { ref: vueRef } = await import('vue')
  lookup.count = vueRef(0)
  return {
    absentLocalHandleCount: lookup.count,
    localHandleExists: (name: string) => lookup.answers.get(name),
    requestLocalHandle: (name: string) => { lookup.requested.push(name) },
  }
})
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
// Cached profile: local alice. The cache matches usernames case-insensitively.
vi.mock('@/services/userDataService', () => ({
  userDataService: {
    findUserIdByUsername: (name: string, domain?: string) =>
      name.toLowerCase() === 'alice' && (!domain || domain === 'harmony.test') ? 'alice-id' : null,
    getUserProfile: (id: string) =>
      id === 'alice-id' ? { id, username: 'alice', is_local: true, domain: 'harmony.test' } : null,
  },
}))
vi.mock('@/services/unifiedEmojiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/unifiedEmojiService')>()),
  useUnifiedEmoji: () => ({ isLoaded: ref(false) }),
  loadEmojiData: vi.fn(async () => {}),
}))

import RichTextEditor from '../RichTextEditor.vue'

enableAutoUnmount(afterEach)

beforeEach(() => {
  lookup.answers.clear()
  lookup.requested = []
})

async function editorWith(text: string) {
  const wrapper = mount(RichTextEditor, { props: { modelValue: text }, attachTo: document.body })
  await nextTick()
  return wrapper
}

const pills = (wrapper: Awaited<ReturnType<typeof editorWith>>) =>
  wrapper.findAll('.editor-mention').map((p) => p.attributes('data-username'))
const plainText = (wrapper: Awaited<ReturnType<typeof editorWith>>) =>
  (wrapper.vm as unknown as { getPlainText: () => string }).getPlainText()

describe('RichTextEditor with a local handle of no account', () => {
  it('draws a handle known to name no account as the text typed', async () => {
    lookup.answers.set('5', false).set('gasdghasidghasdg', false)
    const text = 'see you @5:32 or @gasdghasidghasdg ok'
    const wrapper = await editorWith(text)
    expect(pills(wrapper)).toEqual([])
    expect(plainText(wrapper)).toBe(text)
  })

  it('draws a handle not looked up yet as a pill, asks, and redraws it as text on the answer', async () => {
    const text = 'see you @5:32 ok'
    const wrapper = await editorWith(text)
    expect(pills(wrapper)).toEqual(['5'])
    expect(lookup.requested).toContain('5')

    lookup.answers.set('5', false)
    lookup.count.value++
    await nextTick()
    await nextTick()
    expect(pills(wrapper)).toEqual([])
    expect(plainText(wrapper)).toBe(text)
  })

  it('keeps a pill whose account exists after the answer', async () => {
    const wrapper = await editorWith('ping @bob now')
    lookup.answers.set('bob', true)
    lookup.count.value++
    await nextTick()
    await nextTick()
    expect(pills(wrapper)).toEqual(['bob'])
  })

  it('draws a cached account as a pill without asking', async () => {
    const wrapper = await editorWith('hi @alice there')
    expect(pills(wrapper)).toEqual(['alice'])
    expect(lookup.requested).toEqual([])
  })

  it('asks for a cached account typed in another case, as the send path matches exactly', async () => {
    lookup.answers.set('Alice', false)
    const wrapper = await editorWith('hi @Alice there')
    expect(pills(wrapper)).toEqual([])
    expect(plainText(wrapper)).toBe('hi @Alice there')
  })

  it('keeps a remote handle a pill without asking', async () => {
    const wrapper = await editorWith('hi @nobody@far.example there')
    expect(pills(wrapper)).toEqual(['nobody'])
    expect(lookup.requested).toEqual([])
  })

  it('treats @user@<local host> as the local handle', async () => {
    lookup.answers.set('nobody', false)
    const wrapper = await editorWith('hi @nobody@harmony.test there')
    expect(pills(wrapper)).toEqual([])
    expect(plainText(wrapper)).toBe('hi @nobody@harmony.test there')
  })
})
