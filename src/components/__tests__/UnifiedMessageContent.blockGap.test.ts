/**
 * Text that follows a block (a preview card, inline media, a file) starts below it: its leading
 * line breaks are not drawn, so no empty gap opens under the block.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
}))

const PAGE = { type: 'url', url: 'https://example.com/article', embedId: 'e1' }
const PAYLOADS = {
  e1: { cacheKey: 'e1', url: 'https://example.com/article', normalizedUrl: 'https://example.com/article',
        provider: 'generic', title: 'Article', fetchedAt: '', expiresAt: '' },
}

async function render(content: unknown[]) {
  setActivePinia(createPinia())
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  const { default: UnifiedMessageContent } = await import('@/components/UnifiedMessageContent.vue')
  const wrapper = shallowMount(UnifiedMessageContent, {
    props: { content, messageId: 'm1', editableContent: '', metadata: {}, embedPayloads: PAYLOADS },
    global: { mocks: { $t: (key: string) => key } },
  })
  await flushPromises()
  return wrapper
}

const textSpans = (w: Awaited<ReturnType<typeof render>>) => w.findAll('.text-content').map((s) => s.html())

describe('UnifiedMessageContent text after a block', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('drops the line breaks that open the text after a preview card', async () => {
    const w = await render([{ type: 'text', text: "It's supported " }, PAGE, { type: 'text', text: '\n\nThere is a basic one\nfor now' }])
    expect(w.findComponent({ name: 'ProviderEmbedSwitch' }).exists()).toBe(true)
    const after = textSpans(w).at(-1)!
    expect(after).not.toMatch(/^<span[^>]*>\s*<br/)
    expect(after).toContain('There is a basic one')
    expect(after).toMatch(/one<br[^>]*>for now/)
  })

  it('keeps leading line breaks after inline text such as a link without a preview', async () => {
    const w = await render([{ type: 'text', text: 'see ' }, { type: 'url', url: 'https://example.com/plain' }, { type: 'text', text: '\n\nnext' }])
    expect(textSpans(w).at(-1)).toMatch(/<br/)
  })
})
