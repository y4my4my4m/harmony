/**
 * Gallery images carry their description as alt text, never the file name; an
 * image without one says so. Each opens the lightbox from a keyboard button.
 */

import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
}))
vi.mock('@/composables/useFloatingVideo', () => ({
  useFloatingVideo: () => ({ notifyPlaybackStarted: vi.fn() }),
  useFloatingVideoRefs: () => ({ bind: vi.fn(), canPopOut: () => false, popOut: vi.fn() }),
}))

import MessageMediaGallery from '../MessageMediaGallery.vue'

describe('MessageMediaGallery alt text', () => {
  it('uses descriptions and says when there is none', async () => {
    const wrapper = mount(MessageMediaGallery, {
      props: {
        parts: [
          { type: 'file', fileType: 'image', url: 'https://x.test/cat.png', fileName: 'cat.png', altText: 'A grey cat' },
          { type: 'file', fileType: 'image', url: 'https://x.test/DSC_1.png', fileName: 'DSC_1.png' },
        ] as never,
        imageLoaded: {},
      },
      global: { stubs: { AttachmentRemoveButton: true, MediaUploadProgress: true, Icon: true } },
    })
    const alts = wrapper.findAll('img.content-image').map((img) => img.attributes('alt'))
    expect(alts).toEqual(['A grey cat', 'messageA11y.image.noDescription'])
    const open = wrapper.findAll('button.media-open')
    expect(open.map((b) => b.attributes('aria-label'))).toEqual(['messageA11y.image.openIndexed', 'messageA11y.image.openIndexed'])
    await open[1].trigger('click')
    expect(wrapper.emitted('open-lightbox')).toEqual([['https://x.test/DSC_1.png']])
  })
})
