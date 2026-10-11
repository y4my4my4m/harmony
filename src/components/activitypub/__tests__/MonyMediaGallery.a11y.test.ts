/**
 * MonyMediaGallery.vue for keyboard and screen readers: sensitive media is inert and
 * aria-hidden behind a reveal button that comes first, focus moves between the reveal
 * and hide buttons, each lightbox tile is a single button named by its description
 * with its controls beside it, and a video played in place is named by its
 * description.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { nextTick } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key) }),
}))

import MonyMediaGallery from '../MonyMediaGallery.vue'

enableAutoUnmount(afterEach)

const stubs = { MonyMediaLightbox: true, Icon: true }
const images = [
  { id: '1', type: 'image', url: 'https://s/1.webp', description: 'A cat on a wall' },
  { id: '2', type: 'image', url: 'https://s/2.webp' },
] as any

describe('MonyMediaGallery accessibility', () => {
  it('keeps sensitive media inert and hidden behind a reveal button that comes first', async () => {
    const wrapper = mount(MonyMediaGallery, {
      props: { mediaAttachments: images, isSensitive: true },
      global: { stubs },
      attachTo: document.body,
    })
    const gallery = wrapper.get('.media-gallery').element
    expect(gallery.firstElementChild?.classList.contains('sensitive-overlay')).toBe(true)
    for (const item of wrapper.findAll('.media-item')) {
      expect(item.attributes('inert')).toBeDefined()
      expect(item.attributes('aria-hidden')).toBe('true')
    }

    const reveal = wrapper.get('[data-testid="media-reveal"]')
    ;(reveal.element as HTMLElement).focus()
    await reveal.trigger('click')
    await nextTick()
    await nextTick()
    const hide = wrapper.get('.sensitive-hide-btn')
    expect(document.activeElement).toBe(hide.element)
    for (const item of wrapper.findAll('.media-item')) {
      expect(item.attributes('inert')).toBeUndefined()
      expect(item.attributes('aria-hidden')).toBeUndefined()
    }

    await hide.trigger('click')
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(wrapper.get('[data-testid="media-reveal"]').element)
  })

  it('makes each lightbox tile one button named by its description, with controls beside it', () => {
    const wrapper = mount(MonyMediaGallery, { props: { mediaAttachments: images }, global: { stubs } })
    const tiles = wrapper.findAll('button.media-open')
    expect(tiles).toHaveLength(2)
    expect(tiles[0].get('img').attributes('alt')).toBe('A cat on a wall')
    expect(tiles[1].get('img').attributes('alt')).toBe('activitypub.mediaA11y.imageNoDescription')
    for (const tile of tiles) expect(tile.findAll('button')).toHaveLength(0)
    const alt = wrapper.get('.alt-badge')
    expect(alt.element.closest('button.media-open')).toBeNull()
    expect(wrapper.get('.media-download-overlay').attributes('aria-label')).toMatch(/^activitypub\.mediaA11y\.download:/)
  })

  it('names a video played in place by its description', () => {
    const wrapper = mount(MonyMediaGallery, {
      props: { mediaAttachments: [{ id: 'v', type: 'video', url: 'https://s/v.mp4', description: 'A dog catching a ball' }] as any },
      global: { stubs },
    })
    expect(wrapper.find('button.media-open').exists()).toBe(false)
    expect(wrapper.get('video').attributes('aria-label')).toBe('A dog catching a ball')
  })
})
