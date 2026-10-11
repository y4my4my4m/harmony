/**
 * Message content for screen-reader and keyboard users: image descriptions as alt
 * text (never the file name) and a keyboard opener for the lightbox, spoilers out
 * of the accessibility tree until revealed, mentions and hashtags as buttons,
 * channel references as links, and click-to-decrypt as a named button.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { THROTTLE_MS, WRITE_DELAY_MS, announcerRegions, resetAnnouncer } from '@/composables/useAnnouncer'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
}))

let wrapper: VueWrapper | null = null

// The component's module graph is large; its first transform outlasts a test timeout.
beforeAll(async () => {
  await import('@/components/UnifiedMessageContent.vue')
}, 60_000)

async function render(content: unknown[], props: Record<string, unknown> = {}) {
  setActivePinia(createPinia())
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  const { default: UnifiedMessageContent } = await import('@/components/UnifiedMessageContent.vue')
  wrapper = mount(UnifiedMessageContent, {
    props: { content, messageId: 'm1', editableContent: '', ...props },
    global: {
      mocks: { $t: (key: string) => key },
      stubs: { DisplayName: true, ProviderEmbedSwitch: true, MessageMediaGallery: true, MediaUploadProgress: true, VoiceMessagePlayer: true, PollCard: true, ConfirmationModal: true, CodeBlock: true },
    },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  resetAnnouncer()
})

const image = (extra: Record<string, unknown>) => ({ type: 'file', fileType: 'image', url: 'https://example.test/a.png', fileName: 'IMG_0042.png', ...extra })

describe('UnifiedMessageContent images', () => {
  it('uses the description as alt text and never the file name', async () => {
    const w = await render([image({ altText: 'A red sunset' })])
    expect(w.get('img.content-image').attributes('alt')).toBe('A red sunset')
    await w.setProps({ content: [image({})] })
    expect(w.get('img.content-image').attributes('alt')).toBe('messageA11y.image.noDescription')
    expect(w.html()).not.toContain('alt="IMG_0042.png"')
  })

  it('opens the lightbox from a keyboard button over the image', async () => {
    const w = await render([image({ altText: 'A red sunset' })])
    const open = w.get('button.media-open')
    expect(open.attributes('aria-label')).toBe('messageA11y.image.open')
    await open.trigger('click')
    expect(w.emitted('open-lightbox')).toEqual([['https://example.test/a.png']])
  })

  it('keeps a covered spoiler image out of the accessibility tree until revealed', async () => {
    const w = await render([image({ fileName: 'SPOILER_cat.png', altText: 'A cat' })])
    expect(w.get('img.content-image').attributes('aria-hidden')).toBe('true')
    expect(w.find('button.media-open').exists()).toBe(false)
    await w.get('button.media-spoiler-cover').trigger('click')
    expect(w.get('img.content-image').attributes('aria-hidden')).toBeUndefined()
    expect(w.find('button.media-open').exists()).toBe(true)
  })
})

describe('UnifiedMessageContent text spoilers', () => {
  it('is a button named "Spoiler, hidden" until revealed by keyboard, then text that is spoken', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { politeText } = announcerRegions()
    const w = await render([{ type: 'text', text: 'the end: ||he dies|| sad' }])
    const spoiler = w.get('.md-spoiler')
    expect(spoiler.attributes('role')).toBe('button')
    expect(spoiler.attributes('tabindex')).toBe('0')
    expect(spoiler.attributes('aria-expanded')).toBe('false')
    expect(spoiler.attributes('aria-label')).toBe('messageA11y.spoiler.hidden')
    await spoiler.trigger('keydown', { key: 'Enter' })
    expect(spoiler.classes()).toContain('revealed')
    expect(spoiler.attributes('role')).toBeUndefined()
    expect(spoiler.attributes('aria-label')).toBeUndefined()
    vi.advanceTimersByTime(THROTTLE_MS + WRITE_DELAY_MS + 1)
    expect(politeText.value).toBe('messageA11y.spoiler.revealed')
  })
})

describe('UnifiedMessageContent references', () => {
  it('renders mentions and hashtags as buttons and channel references as links', async () => {
    const w = await render([
      { type: 'mention', userId: 'u1', username: 'alice' },
      { type: 'hashtag', name: 'news' },
      { type: 'channel_mention', channelId: 'c1', serverId: 's1', name: 'general' },
    ])
    expect(w.get('button.mention').exists()).toBe(true)
    expect(w.get('button.hashtag').text()).toBe('#news')
    const channel = w.get('a.channel-mention')
    expect(channel.attributes('href')).toBe('/chat/s1/c1')
    await w.get('button.mention').trigger('click')
    expect(w.emitted('show-user-profile')?.[0]?.[0]).toBe('u1')
  })

  it('offers decryption as a named button', async () => {
    const w = await render([{ type: 'text', text: 'c2VjcmV0c2VjcmV0c2VjcmV0' }], { encrypted: true, canDecrypt: true })
    const button = w.get('button.encrypted-click-target')
    expect(button.text()).toContain('messageA11y.encrypted.decrypt')
    await button.trigger('click')
    expect(w.emitted('decrypt-message')).toEqual([['m1']])
  })
})
