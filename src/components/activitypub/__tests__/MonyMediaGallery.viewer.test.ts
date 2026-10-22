/**
 * MonyMediaGallery opens a post's media in the app's media viewer: the viewable items in
 * order, at the tile used, and a video played in place hands its player over.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { nextTick } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

import MonyMediaGallery from '../MonyMediaGallery.vue'
import { closeLightbox, useLightbox } from '@/composables/useLightbox'

enableAutoUnmount(afterEach)
afterEach(() => closeLightbox())

const stubs = { Icon: true }

describe('MonyMediaGallery and the media viewer', () => {
  it('opens the viewable media at the tile used', async () => {
    const media = [
      { id: '1', type: 'image', url: 'https://s/1.webp', description: 'A cat', filename: '1.webp' },
      { id: '2', type: 'audio', url: 'https://s/2.mp3' },
      { id: '3', type: 'gifv', url: 'https://s/3.mp4', preview_url: 'https://s/3.jpg' },
    ] as any
    const wrapper = mount(MonyMediaGallery, { props: { mediaAttachments: media }, global: { stubs } })
    const tiles = wrapper.findAll('button.media-open')
    expect(tiles).toHaveLength(2)
    await tiles[1].trigger('click')
    const request = useLightbox().request.value
    expect(request?.items).toEqual([
      { url: 'https://s/1.webp', type: 'image', alt: 'A cat', name: '1.webp' },
      { url: 'https://s/3.mp4', type: 'video', alt: 'activitypub.video', poster: 'https://s/3.jpg', loop: true, name: undefined },
    ])
    expect(request?.index).toBe(1)
  })

  it("hands a single video's player to the viewer", async () => {
    const wrapper = mount(MonyMediaGallery, {
      props: { mediaAttachments: [{ id: 'v', type: 'video', url: 'https://s/v.mp4', description: 'A dog' }] as any },
      global: { stubs },
      attachTo: document.body,
    })
    await nextTick()
    const video = wrapper.get('video').element as HTMLVideoElement
    wrapper.get('[data-testid="video-expand"]').element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const request = useLightbox().request.value
    expect(request?.items).toEqual([{ url: 'https://s/v.mp4', type: 'video', alt: 'A dog', poster: undefined, loop: false, name: undefined }])
    expect(request?.options.origin).toBe(video)
  })
})
