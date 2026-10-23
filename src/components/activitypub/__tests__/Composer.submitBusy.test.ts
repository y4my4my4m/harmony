/**
 * The submit button of `Composer.vue` while a post is in flight: it keeps its idle label, so
 * its size does not change in any language ("Replying..." is longer than "Reply" in most), is
 * aria-busy with a spinner over the label, and the busy text is announced instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shallowMount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: ref('en') }),
  createI18n: () => ({ install: () => {}, global: { t: (key: string) => key, locale: 'en' } }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }))

vi.mock('@/stores/useProfile', () => ({
  useProfileStore: () => ({ profile: { id: 'me', username: 'me', domain: 'harmony.test', is_local: true } }),
}))
vi.mock('@/stores/useInstanceSettings', () => ({
  useInstanceSettingsStore: () => ({ settings: { maxPostLength: 500 } }),
}))
vi.mock('@/stores/useActivityPub', () => ({
  useActivityPubStore: () => ({ composerDraft: null, keepComposerDraft: vi.fn() }),
}))

const actions = vi.hoisted(() => ({
  submitPost: vi.fn(),
  updatePost: vi.fn(),
  handlePaste: vi.fn(),
  insertEmoji: vi.fn(),
  insertGif: vi.fn(),
  handleFileUpload: vi.fn(),
}))
vi.mock('@/composables/useComposerActions', () => ({ useComposerActions: () => actions }))
vi.mock('@/composables/useAutoSuggest', () => ({
  useAutoSuggest: () => ({
    state: ref({ isActive: false, position: { top: 0, left: 0 }, selectedIndex: 0 }),
    suggestions: ref([]),
    headerText: ref(''),
    handleInput: vi.fn(),
    handleKeyDown: vi.fn(),
    selectSuggestion: vi.fn(),
  }),
}))
vi.mock('@/services/drive/driveService', () => ({
  driveAvailable: () => Promise.resolve(false),
  driveViewUrl: () => '',
}))

const announcer = vi.hoisted(() => ({ polite: vi.fn(), assertive: vi.fn() }))
vi.mock('@/composables/useAnnouncer', () => ({ useAnnouncer: () => announcer }))

import Composer from '../Composer.vue'

const replyTo = {
  id: 'post-1',
  author: { id: 'a1', username: 'alice', domain: 'remote.example', is_local: false },
  content: [{ type: 'text', text: 'hello' }],
  visibility: 'public',
  metadata: {},
} as any

const deferred = () => {
  let resolve!: (value: unknown) => void
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

const mountReply = () => shallowMount(Composer, {
  props: { mode: 'inline', type: 'reply', replyToPost: replyTo },
  global: {
    directives: { 'click-outside': {} },
    stubs: {
      RichTextEditor: { name: 'RichTextEditor', render: () => null, methods: { focus() {}, setCursorPosition() {} } },
    },
  },
})

describe('Composer submit while sending', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the idle label, is busy and announces the busy text', async () => {
    const send = deferred()
    actions.submitPost.mockReturnValue(send.promise)
    const wrapper = mountReply()
    await flushPromises()

    const button = wrapper.get('[data-testid="compose-submit"]')
    expect(button.text()).toBe('activitypub.reply')
    expect(button.attributes('aria-busy')).toBeUndefined()

    await button.trigger('click')

    expect(actions.submitPost).toHaveBeenCalled()
    expect(button.text()).toBe('activitypub.reply')
    expect(button.find('.post-button-label').text()).toBe('activitypub.reply')
    expect(button.attributes('aria-busy')).toBe('true')
    expect(button.classes()).toContain('is-busy')
    expect(button.find('.post-button-spinner').exists()).toBe(true)
    expect(button.attributes('disabled')).toBeDefined()
    expect(announcer.polite).toHaveBeenCalledWith('activitypub.replying', { key: 'composer-submit' })

    send.resolve({ id: 'reply-1' })
    await flushPromises()

    expect(button.attributes('aria-busy')).toBeUndefined()
    expect(button.classes()).not.toContain('is-busy')
    expect(wrapper.emitted('posted')?.[0]).toEqual([{ id: 'reply-1' }])
  })
})
