/**
 * metadata.suppress_embeds and <url> (preview false) render links: no inline image, video,
 * gallery or preview card.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
}))

const IMAGE = { type: 'url', url: 'https://cdn.example/cat.png' }
const IMAGE2 = { type: 'url', url: 'https://cdn.example/dog.png' }
const PAGE = { type: 'url', url: 'https://example.com/article', embedId: 'e1' }
const PAYLOADS = {
  e1: { cacheKey: 'e1', url: 'https://example.com/article', normalizedUrl: 'https://example.com/article',
        provider: 'generic', title: 'Article', fetchedAt: '', expiresAt: '' },
}

async function render(content: unknown[], metadata: Record<string, unknown> = {}) {
  setActivePinia(createPinia())
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  const { default: UnifiedMessageContent } = await import('@/components/UnifiedMessageContent.vue')
  const wrapper = shallowMount(UnifiedMessageContent, {
    props: { content, messageId: 'm1', editableContent: '', metadata, embedPayloads: PAYLOADS },
    global: { mocks: { $t: (key: string) => key } },
  })
  await flushPromises()
  return wrapper
}

describe('UnifiedMessageContent embed suppression', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('renders media and preview cards normally', async () => {
    const w = await render([IMAGE, { type: 'text', text: ' ' }, PAGE])
    expect(w.find('img.content-image').exists()).toBe(true)
    expect(w.findComponent({ name: 'ProviderEmbedSwitch' }).exists()).toBe(true)
  })

  it('renders only links when the message suppresses embeds', async () => {
    const w = await render([IMAGE, IMAGE2, { type: 'text', text: ' ' }, PAGE], { suppress_embeds: true })
    expect(w.find('img.content-image').exists()).toBe(false)
    expect(w.findComponent({ name: 'MessageMediaGallery' }).exists()).toBe(false)
    expect(w.findComponent({ name: 'ProviderEmbedSwitch' }).exists()).toBe(false)
    expect(w.findAll('a.url-link').map(a => a.attributes('href'))).toEqual([IMAGE.url, IMAGE2.url, PAGE.url])
  })

  it('renders a <url> image as a link', async () => {
    const w = await render([{ ...IMAGE, preview: false }])
    expect(w.find('img.content-image').exists()).toBe(false)
    expect(w.find('a.url-link').attributes('href')).toBe(IMAGE.url)
  })
})
