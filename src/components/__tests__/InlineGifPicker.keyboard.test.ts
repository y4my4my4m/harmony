/**
 * InlineGifPicker (/gif strip): each result is a pick button with one Tab stop for the
 * strip, Left/Right move between results, Down and Escape hand focus back to the
 * composer, and keyboard focus magnifies the focused result, whose full rendition loads
 * after a short dwell while the strip keeps thumbnails.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'
import InlineGifPicker from '../InlineGifPicker.vue'

vi.mock('@/composables/useLayoutState', () => ({
  useLayoutState: () => ({ isMobile: ref(false) }),
}))

const gif = (i: number) => ({
  kind: 'gif' as const,
  id: `g${i}`,
  title: `gif ${i}`,
  media_formats: {
    gif: { url: `https://m.test/full/${i}.gif` },
    gifpreview: { url: `https://m.test/thumb/${i}.jpg` },
    mp4: { url: `https://m.test/full/${i}.mp4` },
    webm: { url: `https://m.test/full/${i}.webm` },
  },
})

vi.mock('@/services/gifProviderService', () => ({
  gifProvider: {
    trending: vi.fn(async () => ({
      items: [gif(0), { kind: 'ad', id: 'ad:0', content: '<p>ad</p>', width: 300, height: 88 }, gif(1), gif(2)],
      page: 1,
      hasNext: false,
    })),
    search: vi.fn(async () => ({ items: [], page: 1, hasNext: false })),
  },
}))

describe('InlineGifPicker keyboard and magnification', () => {
  let wrapper: VueWrapper

  beforeEach(async () => {
    wrapper = mount(InlineGifPicker, {
      props: { query: '' },
      attachTo: document.body,
      global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })], stubs: { GifAdSlot: true } },
    })
    await flushPromises()
  })

  afterEach(() => {
    wrapper.unmount()
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  const tiles = () => wrapper.findAll('[data-gif-tile]')
  const thumbs = () => wrapper.findAll('[data-gif-tile] img').map((i) => i.attributes('src'))

  it('renders a pick button per GIF, ads excluded, with one Tab stop', () => {
    expect(tiles().map((t) => t.attributes('data-gif-tile'))).toEqual(['g0', 'g1', 'g2'])
    expect(tiles().map((t) => t.attributes('tabindex'))).toEqual(['0', '-1', '-1'])
    expect(tiles().every((t) => t.element.tagName === 'BUTTON')).toBe(true)
  })

  it('sends the result its button picks', async () => {
    await tiles()[1].trigger('click')
    const sent = wrapper.emitted('selectGif')?.[0]?.[0] as { id: string }
    expect(sent.id).toBe('g1')
  })

  it('takes focus from the composer and moves with Left and Right', async () => {
    const vm = wrapper.vm as unknown as { focusResults: () => boolean }
    expect(vm.focusResults()).toBe(true)
    expect(document.activeElement).toBe(tiles()[0].element)

    await tiles()[0].trigger('keydown', { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tiles()[1].element)
    expect(tiles().map((t) => t.attributes('tabindex'))).toEqual(['-1', '0', '-1'])

    await tiles()[1].trigger('keydown', { key: 'End' })
    expect(document.activeElement).toBe(tiles()[2].element)
    await tiles()[2].trigger('keydown', { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tiles()[2].element)
    await tiles()[2].trigger('keydown', { key: 'Home' })
    expect(document.activeElement).toBe(tiles()[0].element)
  })

  it('hands focus back to the composer on Down and Escape', async () => {
    await tiles()[0].trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.emitted('exit')).toHaveLength(1)
    await tiles()[1].trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('exit')).toHaveLength(2)
  })

  it('magnifies the focused result and loads its full rendition only', async () => {
    expect(thumbs()).toEqual(['https://m.test/thumb/0.jpg', 'https://m.test/thumb/1.jpg', 'https://m.test/thumb/2.jpg'])
    expect(document.querySelector('[data-testid="gif-dock"]')).toBeNull()

    vi.useFakeTimers()
    const button = tiles()[1].element as HTMLElement
    button.matches = ((sel: string) => sel === ':focus-visible') as typeof button.matches
    button.focus()
    await wrapper.vm.$nextTick()

    const dock = document.querySelector('[data-testid="gif-dock"]')
    expect(dock).not.toBeNull()
    expect(dock?.getAttribute('aria-hidden')).toBe('true')
    expect(wrapper.find('.inline-gif-grid').classes()).toContain('docked')
    expect(document.querySelector('.gif-dock-tile.focus')?.getAttribute('data-dock-tile')).toBe('g1')
    expect(document.querySelector('.gif-dock-full')).toBeNull()

    vi.advanceTimersByTime(120)
    await wrapper.vm.$nextTick()
    const full = Array.from(document.querySelectorAll('.gif-dock-full')).map((el) => el.getAttribute('src'))
    expect(full).toEqual(['https://m.test/full/1.gif'])
    expect(thumbs()).toEqual(['https://m.test/thumb/0.jpg', 'https://m.test/thumb/1.jpg', 'https://m.test/thumb/2.jpg'])
  })

  it('sends the result a magnified tile shows', async () => {
    const button = tiles()[2].element as HTMLElement
    button.matches = ((sel: string) => sel === ':focus-visible') as typeof button.matches
    button.focus()
    await wrapper.vm.$nextTick()
    // Vue drops a bubbling event whose capture-phase stamp (Date.now) is not later than the
    // bubble listener's attach time; a click in the same millisecond as the render is lost.
    await new Promise((r) => setTimeout(r, 2))
    ;(document.querySelector('[data-dock-tile="g2"]') as HTMLElement).click()
    const sent = wrapper.emitted('selectGif')?.[0]?.[0] as { id: string }
    if (!sent) (await import('node:fs')).appendFileSync('/tmp/claude-1000/-home-y4my4m-gits-hobby-harmony-rebuild/ca1c573d-bcf7-47a2-93da-9613d8b3569f/scratchpad/dbg.txt', JSON.stringify({ dock: Object.keys(wrapper.findComponent({ name: 'InlineGifDock' }).emitted?.() ?? {}), tiles: document.querySelectorAll('[data-dock-tile]').length, html: document.querySelector('[data-dock-tile="g2"]')?.outerHTML?.slice(0,200), emitted: Object.keys(wrapper.emitted()) }) + '\n')
    expect(sent.id).toBe('g2')
  })
})
