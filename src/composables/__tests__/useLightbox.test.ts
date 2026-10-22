import { afterEach, describe, expect, it } from 'vitest'
import { closeLightbox, openLightbox, useLightbox, type LightboxMedia } from '@/composables/useLightbox'

const items: LightboxMedia[] = [
  { url: 'https://x.test/a.png', type: 'image', name: 'a.png' },
  { url: 'https://x.test/b.mp4', type: 'video', poster: 'https://x.test/b.jpg' },
  { url: 'https://x.test/c.ogg', type: 'audio', name: 'c.ogg' },
]

afterEach(() => closeLightbox())

describe('openLightbox', () => {
  it('opens the list at the start index', () => {
    const { request } = useLightbox()
    openLightbox(items, 1)
    expect(request.value?.items).toEqual(items)
    expect(request.value?.index).toBe(1)
    expect(request.value?.options).toEqual({})
  })

  it('starts at the first item by default and clamps the index', () => {
    const { request } = useLightbox()
    openLightbox(items)
    expect(request.value?.index).toBe(0)
    openLightbox(items, 9)
    expect(request.value?.index).toBe(2)
    openLightbox(items, -3)
    expect(request.value?.index).toBe(0)
  })

  it('does nothing for an empty list', () => {
    const { request } = useLightbox()
    openLightbox([], 0)
    expect(request.value).toBeNull()
  })

  it('drops items without a source and keeps the start on the requested item', () => {
    const { request } = useLightbox()
    openLightbox([{ url: '', type: 'image' }, items[0], items[1]], 2)
    expect(request.value?.items).toEqual([items[0], items[1]])
    expect(request.value?.index).toBe(1)
  })

  it('replaces a viewer already open and closes', () => {
    const { request, close } = useLightbox()
    openLightbox(items, 0)
    const first = request.value?.id
    const origin = document.createElement('video')
    openLightbox(items.slice(1), 0, { origin, download: false })
    expect(request.value?.id).not.toBe(first)
    expect(request.value?.options.origin).toBe(origin)
    close()
    expect(request.value).toBeNull()
  })
})
