/**
 * The Stickers tab's custom sections: the current server's (in a server channel only), the
 * instance's and the caller's, filtered by name or description.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', async (importOriginal) => {
  const messages = (await import('@/locales/en.json')).default as Record<string, any>
  const t = (key: string, params: Record<string, unknown> = {}) => {
    const message = key.split('.').reduce<any>((node, part) => node?.[part], messages)
    return typeof message === 'string'
      ? message.replace(/\{(\w+)\}/g, (_: string, name: string) => String(params[name] ?? `{${name}}`))
      : key
  }
  return { ...(await importOriginal<typeof import('vue-i18n')>()), useI18n: () => ({ t }) }
})
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ currentServerId: 'srv', currentServer: { name: 'Cats' } }),
}))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: { id: 'me' } }) }))
vi.mock('@/services/instanceCapabilities', () => ({ hasCapability: () => true }))

const row = (id: string, scope: string, name: string, description = 'd') => ({
  id, scope, name, description, url: `https://h.test/${id}.png`, server_id: scope === 'server' ? 'srv' : null,
  owner_id: scope === 'user' ? 'me' : null,
})
const lists = vi.hoisted(() => ({
  listServerStickers: vi.fn(),
  listInstanceStickers: vi.fn(),
  listMyStickers: vi.fn(),
  existingStickerIds: vi.fn(),
}))
vi.mock('@/services/stickerService', () => lists)

import StickerPickerSection from '../StickerPickerSection.vue'

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  lists.listServerStickers.mockResolvedValue([row('a', 'server', 'Cat wave')])
  lists.listInstanceStickers.mockResolvedValue([row('b', 'instance', 'Party', 'Confetti falling')])
  lists.listMyStickers.mockResolvedValue([row('c', 'user', 'Me')])
})

describe('StickerPickerSection', () => {
  it('lists server, instance and personal stickers in a server channel', async () => {
    const wrapper = mount(StickerPickerSection, { props: { query: '', channelId: 'chan' } })
    await flushPromises()
    expect(wrapper.findAll('h3').map((h) => h.text())).toEqual(['Cats', 'Instance stickers', 'My stickers'])
    expect(lists.listServerStickers).toHaveBeenCalledWith('srv')
  })

  it('leaves server stickers out of a DM', async () => {
    const wrapper = mount(StickerPickerSection, { props: { query: '', channelId: null } })
    await flushPromises()
    expect(lists.listServerStickers).not.toHaveBeenCalled()
    expect(wrapper.findAll('h3').map((h) => h.text())).toEqual(['Instance stickers', 'My stickers'])
  })

  it('filters by name or description and sends the picked sticker', async () => {
    const wrapper = mount(StickerPickerSection, { props: { query: 'confetti', channelId: 'chan' } })
    await flushPromises()
    const picks = wrapper.findAll('[data-testid="sticker-pick"]')
    expect(picks).toHaveLength(1)
    expect(picks[0].attributes('aria-label')).toBe('Send sticker Party: Confetti falling')
    await picks[0].trigger('click')
    expect(wrapper.emitted('send')?.[0]?.[0]).toMatchObject({ id: 'b' })
  })
})
