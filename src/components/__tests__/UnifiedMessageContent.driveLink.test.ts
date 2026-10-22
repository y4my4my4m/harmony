/**
 * A Drive link renders its file below the text. A message that is only the link shows the file
 * without the link text, as Discord drops an image URL that is the whole message; beside other
 * text, or with embeds suppressed, the link stays.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
}))

const here = () => `${window.location.protocol}//${window.location.host}`
const FILE = () => ({ type: 'url', url: `${here()}/drive/file/3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b`, preview: true })
const TOKEN = () => ({ type: 'url', url: `${here()}/d/h5KAj-hPSm5hwCpMfeKM8aZl`, preview: true })

async function render(content: unknown[], metadata: Record<string, unknown> = {}) {
  setActivePinia(createPinia())
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  const { default: UnifiedMessageContent } = await import('@/components/UnifiedMessageContent.vue')
  const wrapper = shallowMount(UnifiedMessageContent, {
    props: { content, messageId: 'm1', editableContent: '', metadata },
    global: { mocks: { $t: (key: string) => key } },
  })
  await flushPromises()
  return wrapper
}

const embedUrls = (w: Awaited<ReturnType<typeof render>>) =>
  w.findAllComponents({ name: 'ProviderEmbedSwitch' }).map((c) => (c.props('payload') as { url: string }).url)

describe('UnifiedMessageContent Drive links', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('shows a message that is only a Drive link as the file, without the link text', async () => {
    for (const link of [FILE(), TOKEN()]) {
      const w = await render([{ type: 'text', text: ' ' }, link])
      expect(w.find('a.url-link').exists()).toBe(false)
      expect(w.text()).not.toContain(link.url)
      expect(embedUrls(w)).toEqual([link.url])
    }
  })

  it('keeps the link in the text beside other words, with the file below', async () => {
    const link = FILE()
    const w = await render([{ type: 'text', text: 'harbor photo ' }, link])
    expect(w.find('a.url-link').attributes('href')).toBe(link.url)
    expect(embedUrls(w)).toEqual([link.url])
  })

  it('keeps every link when a message holds two', async () => {
    const w = await render([FILE(), { type: 'text', text: ' ' }, TOKEN()])
    expect(w.findAll('a.url-link')).toHaveLength(2)
    expect(embedUrls(w)).toHaveLength(2)
  })

  it('keeps the link of a message that suppresses embeds, and of a <url> link', async () => {
    const suppressed = await render([FILE()], { suppress_embeds: true })
    expect(suppressed.find('a.url-link').exists()).toBe(true)
    expect(embedUrls(suppressed)).toEqual([])
    const bracketed = await render([{ ...FILE(), preview: false }])
    expect(bracketed.find('a.url-link').exists()).toBe(true)
    expect(embedUrls(bracketed)).toEqual([])
  })
})
