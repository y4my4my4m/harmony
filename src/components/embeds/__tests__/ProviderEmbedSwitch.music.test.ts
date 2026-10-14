/**
 * Music links render their service's player, chosen by the link: a SoundCloud page whose
 * preview failed, a Spotify track, and a Spotify short link through its canonical URL.
 */
import { describe, it, expect, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
}))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))

const base = { cacheKey: 'k', fetchedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-10-02T00:00:00Z' }

async function mount(payload: Record<string, unknown>) {
  const { default: ProviderEmbedSwitch } = await import('../ProviderEmbedSwitch.vue')
  const wrapper = shallowMount(ProviderEmbedSwitch, { props: { payload: { ...base, ...payload } as any, messageId: 'm1' } })
  await flushPromises()
  return wrapper
}

describe('music players', () => {
  it('plays a SoundCloud track even when its preview failed', async () => {
    const url = 'https://soundcloud.com/someone/night-drive'
    const wrapper = await mount({ url, normalizedUrl: url, provider: 'generic', failed: true, title: url })
    const music = wrapper.findComponent({ name: 'MusicEmbed' })
    expect(music.exists()).toBe(true)
    expect(music.props('embed')).toMatchObject({ provider: 'soundcloud', height: 166 })
    expect(wrapper.find('.provider-embed__label').text()).toBe('SoundCloud')
  })

  it('plays a Spotify track in its player', async () => {
    const url = 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'
    const wrapper = await mount({ url, normalizedUrl: url, provider: 'spotify', title: 'Song' })
    expect(wrapper.findComponent({ name: 'MusicEmbed' }).props('embed').src)
      .toBe('https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC?utm_source=harmony&theme=0')
  })

  it('follows a short link through the canonical URL of its preview', async () => {
    const url = 'https://spotify.link/AbCdEf123'
    const wrapper = await mount({
      url, normalizedUrl: url, provider: 'spotify', title: 'Song',
      canonicalUrl: 'https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3',
    })
    expect(wrapper.findComponent({ name: 'MusicEmbed' }).props('embed')).toMatchObject({ provider: 'spotify', height: 352 })
  })

  it('leaves other links to the card', async () => {
    const url = 'https://example.com/article'
    const wrapper = await mount({ url, normalizedUrl: url, provider: 'generic', title: 'An article' })
    expect(wrapper.findComponent({ name: 'MusicEmbed' }).exists()).toBe(false)
  })
})
