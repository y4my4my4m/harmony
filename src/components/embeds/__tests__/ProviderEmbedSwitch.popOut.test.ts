/**
 * A YouTube embed's header carries a Pop out action that floats the embed;
 * the action is absent while the embed is collapsed and on non-video embeds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
}))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))

class FakeIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return [] }
}

const YOUTUBE = {
  cacheKey: 'yt',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  normalizedUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  provider: 'youtube' as const,
  title: 'A video',
  fetchedAt: '2026-10-01T00:00:00Z',
  expiresAt: '2026-10-02T00:00:00Z',
}

const SPOTIFY = {
  ...YOUTUBE,
  cacheKey: 'sp',
  url: 'https://open.spotify.com/track/abc',
  normalizedUrl: 'https://open.spotify.com/track/abc',
  provider: 'spotify' as const,
}

async function setup(payload: typeof YOUTUBE | typeof SPOTIFY) {
  vi.resetModules()
  const floating = await import('@/composables/useFloatingVideo')
  const { default: ProviderEmbedSwitch } = await import('../ProviderEmbedSwitch.vue')

  const slot = document.createElement('div')
  const probe = document.createElement('div')
  document.body.append(slot, probe)
  floating.useFloatingVideoPlayer().attachHost(slot, probe)

  const wrapper = shallowMount(ProviderEmbedSwitch, {
    props: { payload, messageId: 'm1' },
    attachTo: document.body,
  })
  await flushPromises()
  return { wrapper, slot }
}

function actionLabels(wrapper: Awaited<ReturnType<typeof setup>>['wrapper']): string[] {
  return wrapper.findAll('.embed-action').map(b => b.text())
}

// happy-dom fetches iframe pages over the network unless page loading is
// disabled; a disabled load reports through console.error.
const happyDOM = (window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM

describe('ProviderEmbedSwitch pop out', () => {
  beforeEach(() => {
    happyDOM.settings.disableIframePageLoading = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    happyDOM.settings.disableIframePageLoading = false
  })

  it('floats a YouTube embed from the header', async () => {
    const { wrapper, slot } = await setup(YOUTUBE)
    expect(actionLabels(wrapper)).toEqual(['embeds.popOut', 'embeds.open', 'embeds.hide'])

    const embed = wrapper.find('.provider-embed').element
    await wrapper.findAll('.embed-action')[0].trigger('click')
    expect(embed.parentElement).toBe(slot)
    wrapper.unmount()
  })

  it('hides the action while collapsed', async () => {
    const { wrapper } = await setup(YOUTUBE)
    await wrapper.findAll('.embed-action')[2].trigger('click')
    expect(actionLabels(wrapper)).toEqual(['embeds.open', 'embeds.show'])
    wrapper.unmount()
  })

  it('offers no pop out on a non-video embed', async () => {
    const { wrapper } = await setup(SPOTIFY)
    expect(actionLabels(wrapper)).toEqual(['embeds.open', 'embeds.hide'])
    wrapper.unmount()
  })
})
