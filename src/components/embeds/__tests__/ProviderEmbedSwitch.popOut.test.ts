/**
 * An embed's actions sit on a rail beside the card, not in a header above it. A YouTube
 * embed's rail carries Pop out, which floats the embed; the action is absent while the
 * embed is hidden and on non-video embeds. Hidden, the embed is one row naming the provider.
 * Open hands the page to openLink (services/tauriLinks), which leaves the app on mobile.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
}))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))
vi.mock('@/services/tauriLinks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/tauriLinks')>()),
  openLink: vi.fn(),
}))

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
  return wrapper.findAll('.embed-action').map(b => b.attributes('aria-label') ?? '')
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

  it('floats a YouTube embed from its rail', async () => {
    const { wrapper, slot } = await setup(YOUTUBE)
    expect(actionLabels(wrapper)).toEqual(['embeds.popOut', 'embeds.open', 'embeds.hide'])
    // No header row: the rail and the card are side by side, the label only shows hidden.
    expect(wrapper.find('.provider-embed__header').exists()).toBe(false)
    expect(wrapper.find('.provider-embed').classes()).toContain('provider-embed--railed')
    expect(wrapper.find('.provider-embed__frame').exists()).toBe(true)
    expect(wrapper.find('.provider-embed__label').exists()).toBe(false)
    expect(wrapper.find('.provider-embed').attributes('aria-label')).toBe('YouTube')

    const embed = wrapper.find('.provider-embed').element
    await wrapper.findAll('.embed-action')[0].trigger('click')
    expect(embed.parentElement).toBe(slot)
    wrapper.unmount()
  })

  it('hides the action while collapsed, leaving one row that names the provider', async () => {
    const { wrapper } = await setup(YOUTUBE)
    await wrapper.findAll('.embed-action')[2].trigger('click')
    expect(actionLabels(wrapper)).toEqual(['embeds.open', 'embeds.show'])
    expect(wrapper.find('.provider-embed__frame').exists()).toBe(false)
    expect(wrapper.find('.provider-embed__actions').classes()).toContain('is-inline')
    expect(wrapper.find('.provider-embed__label').text()).toBe('YouTube')
    wrapper.unmount()
  })

  it('opens the page through openLink', async () => {
    const { wrapper } = await setup(YOUTUBE)
    const { openLink } = await import('@/services/tauriLinks')
    await wrapper.find('.embed-action[aria-label="embeds.open"]').trigger('click')
    expect(openLink).toHaveBeenCalledTimes(1)
    expect(openLink).toHaveBeenCalledWith(YOUTUBE.url)
    wrapper.unmount()
  })

  it('offers no pop out on a non-video embed', async () => {
    const { wrapper } = await setup(SPOTIFY)
    expect(actionLabels(wrapper)).toEqual(['embeds.open', 'embeds.hide'])
    wrapper.unmount()
  })
})
