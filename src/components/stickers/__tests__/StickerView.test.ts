/**
 * A sticker part renders large with its description as alt text. One of this instance is drawn
 * from its row's url, looked up by id; one whose row is gone, whose lookup fails, or whose file
 * fails renders a placeholder that still names it.
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
vi.mock('@/components/common/Icon.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name: 'IconStub', render: () => h('span') }) }
})
const lookup = vi.hoisted(() => ({ existingStickerIds: vi.fn() }))
vi.mock('@/services/stickerService', () => ({
  existingStickerIds: lookup.existingStickerIds,
  listInstanceStickers: vi.fn(),
  listMyStickers: vi.fn(),
  listServerStickers: vi.fn(),
}))

import StickerView from '../StickerView.vue'

const LOCAL_ID = '2060e000-0000-4000-8000-000000000001'
const ROW_URL = 'https://db.test/storage/v1/object/public/stickers/server/a/1.png'
const part = (over: Record<string, unknown> = {}) => ({
  type: 'sticker' as const,
  id: LOCAL_ID,
  url: 'https://h.test/s.png',
  name: 'Cat wave',
  description: 'A cat waving',
  width: 320,
  height: 160,
  ...over,
})

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  lookup.existingStickerIds.mockReset()
})

describe('StickerView', () => {
  it('draws the sticker at 160 px from its row\'s url, with its name and description as alt text', async () => {
    lookup.existingStickerIds.mockResolvedValue(new Map([[LOCAL_ID, ROW_URL]]))
    const wrapper = mount(StickerView, { props: { sticker: part() } })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.get('[data-testid="message-sticker-pending"]').attributes('style')).toContain('width: 160px')
    await vi.advanceTimersByTimeAsync(60)
    await flushPromises()
    expect(lookup.existingStickerIds).toHaveBeenCalledWith([LOCAL_ID])
    const img = wrapper.get('img')
    expect(img.attributes('src')).toBe(ROW_URL)
    expect(img.attributes('alt')).toBe('Sticker Cat wave: A cat waving')
    expect(img.attributes('width')).toBe('160')
    expect(img.attributes('height')).toBe('80')
    expect(wrapper.find('[data-testid="message-sticker-gone"]').exists()).toBe(false)
  })

  it('never draws the url of a part naming a real sticker beside another image', async () => {
    lookup.existingStickerIds.mockResolvedValue(new Map([[LOCAL_ID, ROW_URL]]))
    const wrapper = mount(StickerView, { props: { sticker: part({ url: 'https://evil.test/other.png' }) } })
    await vi.advanceTimersByTimeAsync(60)
    await flushPromises()
    expect(wrapper.get('img').attributes('src')).toBe(ROW_URL)
    expect(wrapper.html()).not.toContain('evil.test')
  })

  it('shows the unavailable placeholder when the lookup fails', async () => {
    lookup.existingStickerIds.mockRejectedValue(new Error('offline'))
    const wrapper = mount(StickerView, { props: { sticker: part() } })
    await vi.advanceTimersByTimeAsync(60)
    await flushPromises()
    expect(wrapper.get('[data-testid="message-sticker-gone"]').text()).toContain('Sticker unavailable')
    expect(wrapper.find('img').exists()).toBe(false)
  })

  it('shows a placeholder once the sticker is removed', async () => {
    lookup.existingStickerIds.mockResolvedValue(new Map())
    const wrapper = mount(StickerView, { props: { sticker: part() } })
    await vi.advanceTimersByTimeAsync(60)
    await flushPromises()
    const gone = wrapper.get('[data-testid="message-sticker-gone"]')
    expect(gone.text()).toContain('Sticker removed')
    expect(gone.attributes('aria-label')).toBe('Sticker Cat wave, no longer available: A cat waving')
    expect(wrapper.find('img').exists()).toBe(false)
  })

  it('does not look up another instance\'s sticker; a failed file shows the placeholder', async () => {
    const wrapper = mount(StickerView, { props: { sticker: part({ domain: 'peer.test' }) } })
    await vi.advanceTimersByTimeAsync(60)
    expect(lookup.existingStickerIds).not.toHaveBeenCalled()
    await wrapper.get('img').trigger('error')
    expect(wrapper.get('[data-testid="message-sticker-gone"]').text()).toContain('Sticker unavailable')
  })
})
