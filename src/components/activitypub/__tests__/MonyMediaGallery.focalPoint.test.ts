/**
 * Timeline galleries crop multi-item cells around the focal point: composer
 * rows carry meta.focus, ActivityPub copies carry focalPoint. A single item is
 * shown whole and stays centred.
 */

import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

import MonyMediaGallery from '../MonyMediaGallery.vue'

const stubs = { MonyMediaLightbox: true }

describe('MonyMediaGallery focal points', () => {
  it('positions local and remote images in a grid', () => {
    const wrapper = mount(MonyMediaGallery, {
      props: {
        mediaAttachments: [
          { id: '1', type: 'image', url: 'https://s/1.webp', meta: { focus: { x: 0.5, y: 0.5 } } },
          { id: '2', type: 'image', url: 'https://r/2.jpg', focalPoint: [-1, -0.5] },
          { id: '3', type: 'image', url: 'https://r/3.jpg' },
        ] as any,
      },
      global: { stubs },
    })
    const images = wrapper.findAll('img.media-image')
    expect(images[0].attributes('style')).toContain('object-position: 75% 25%')
    expect(images[1].attributes('style')).toContain('object-position: 0% 75%')
    expect(images[2].attributes('style')).toBeUndefined()
  })

  it('leaves a single item centred', () => {
    const wrapper = mount(MonyMediaGallery, {
      props: { mediaAttachments: [{ id: '1', type: 'image', url: 'https://s/1.webp', meta: { focus: { x: 1, y: 1 } } }] as any },
      global: { stubs },
    })
    expect(wrapper.get('img.media-image').attributes('style')).toBeUndefined()
  })
})
