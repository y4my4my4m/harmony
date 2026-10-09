/**
 * Video parts register with the floating player when they render, including
 * parts that appear after mount (decryption, edits), and pop out on request.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
}))

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  targets = new Set<Element>()
  constructor(_callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this)
  }
  observe(target: Element) { this.targets.add(target) }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { this.targets.clear() }
  takeRecords() { return [] }
}

function observed(target: Element): boolean {
  return FakeIntersectionObserver.instances.some(io => io.targets.has(target))
}

const VIDEO_FILE = { type: 'file', fileType: 'video', url: 'https://cdn.example/clip.mp4', fileName: 'clip.mp4' }
const VIDEO_URL = { type: 'url', url: 'https://cdn.example/other.webm' }

async function setup(content: unknown[]) {
  vi.resetModules()
  setActivePinia(createPinia())
  const floating = await import('@/composables/useFloatingVideo')
  const { default: UnifiedMessageContent } = await import('@/components/UnifiedMessageContent.vue')

  const slot = document.createElement('div')
  const probe = document.createElement('div')
  document.body.append(slot, probe)
  floating.useFloatingVideoPlayer().attachHost(slot, probe)

  const wrapper = shallowMount(UnifiedMessageContent, {
    props: { content, messageId: 'm1', editableContent: '' },
    global: { mocks: { $t: (key: string) => key } },
    attachTo: document.body,
  })
  await flushPromises()
  return { floating, wrapper, slot }
}

describe('UnifiedMessageContent floating videos', () => {
  beforeEach(() => {
    FakeIntersectionObserver.instances = []
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('registers a video attachment and a bare video url', async () => {
    const { wrapper } = await setup([VIDEO_FILE, { type: 'text', text: 'and' }, VIDEO_URL])
    const containers = wrapper.findAll('.video-container')
    expect(containers).toHaveLength(2)
    for (const c of containers) expect(observed(c.element)).toBe(true)
    expect(wrapper.findAll('.floating-video-popout')).toHaveLength(2)
    wrapper.unmount()
  })

  it('registers a video part that appears after mount', async () => {
    const { wrapper } = await setup([{ type: 'text', text: 'encrypted' }])
    expect(wrapper.find('.video-container').exists()).toBe(false)

    await wrapper.setProps({ content: [{ type: 'text', text: 'look' }, VIDEO_FILE] })
    await flushPromises()
    const container = wrapper.find('.video-container')
    expect(container.exists()).toBe(true)
    expect(observed(container.element)).toBe(true)
    expect(container.find('.floating-video-popout').exists()).toBe(true)
    wrapper.unmount()
  })

  it('unregisters a video part that is removed', async () => {
    const { wrapper } = await setup([VIDEO_FILE])
    const element = wrapper.find('.video-container').element
    expect(observed(element)).toBe(true)

    await wrapper.setProps({ content: [{ type: 'text', text: 'edited' }] })
    await flushPromises()
    expect(observed(element)).toBe(false)
    wrapper.unmount()
  })

  it('pops the video out from its button', async () => {
    const { floating, wrapper, slot } = await setup([VIDEO_FILE])
    const container = wrapper.find('.video-container').element
    await wrapper.find('.floating-video-popout').trigger('click')
    expect(container.parentElement).toBe(slot)
    expect(floating.useFloatingVideo().floatingMessageId.value).toBe('m1')
    wrapper.unmount()
  })
})
