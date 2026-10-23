/**
 * A server whose media this instance hides (instance_server_blocks.media_hidden): files render
 * as one hidden-media notice, links without inline media or preview; the text stays.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { withMediaHidden } from '@/utils/hiddenMedia'

const t = vi.hoisted(() => (key: string, params?: Record<string, unknown>, plural?: number) =>
  `${key}${params ? ` ${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}${plural !== undefined ? ` #${plural}` : ''}`)

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t, locale: { value: 'en' } }),
}))

const TEXT = { type: 'text', text: 'look at these' }
const PHOTO = { type: 'file', url: 'https://host.example/media/a.png', fileType: 'image', fileName: 'a.png' }
const CLIP = { type: 'file', url: 'https://host.example/media/b.mp4', fileType: 'video', fileName: 'b.mp4' }
const DOC = { type: 'file', url: 'https://host.example/media/c.pdf', fileType: 'document', fileName: 'c.pdf' }
const LINKED = { type: 'url', url: 'https://cdn.example/cat.png' }

async function render(content: unknown[], mediaHidden: boolean) {
  setActivePinia(createPinia())
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  const { default: UnifiedMessageContent } = await import('@/components/UnifiedMessageContent.vue')
  const wrapper = shallowMount(UnifiedMessageContent, {
    props: { content, messageId: 'm1', editableContent: '', mediaHidden },
    global: { mocks: { $t: t } },
  })
  await flushPromises()
  return wrapper
}

describe('withMediaHidden', () => {
  it('folds every file into one notice where the first was, and turns off link previews', () => {
    expect(withMediaHidden([TEXT, PHOTO, LINKED, CLIP, DOC] as any)).toEqual([
      TEXT,
      { type: 'media_hidden', count: 3 },
      { ...LINKED, preview: false },
    ])
  })

  it('leaves a message without files or links as it is', () => {
    expect(withMediaHidden([TEXT] as any)).toEqual([TEXT])
  })
})

describe('UnifiedMessageContent with media hidden', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('shows the media when the server\'s media is not hidden', async () => {
    const w = await render([TEXT, PHOTO, DOC], false)
    expect(w.find('[data-testid="media-hidden"]').exists()).toBe(false)
    expect(w.find('img.content-image').exists()).toBe(true)
    expect(w.find('.file-attachment').exists()).toBe(true)
  })

  it('shows one notice naming this instance instead of pictures, videos and files', async () => {
    const w = await render([TEXT, PHOTO, CLIP, DOC], true)
    const notices = w.findAll('[data-testid="media-hidden"]')
    expect(notices).toHaveLength(1)
    expect(notices[0].text()).toMatch(/^instanceServer\.media\.hiddenNotice instance=\S+ #3$/)
    expect(w.find('img.content-image').exists()).toBe(false)
    expect(w.find('video').exists()).toBe(false)
    expect(w.find('.file-attachment').exists()).toBe(false)
    expect(w.text()).toContain('look at these')
  })

  it('renders an image link as a link', async () => {
    const w = await render([LINKED], true)
    expect(w.find('img.content-image').exists()).toBe(false)
    expect(w.find('a.url-link').attributes('href')).toBe(LINKED.url)
  })
})
