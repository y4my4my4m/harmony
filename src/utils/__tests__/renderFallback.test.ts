import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick } from 'vue'

vi.mock('@/supabase', () => ({ supabase: {} }))

import { renderToObjectUrl } from '@/utils/storageImageUtils'
import { installRenderFallback, knownRenderFallback, resetRenderFallback, withRenderFallback } from '@/utils/renderFallback'

const HOST = 'https://harmony.example'
const RENDER = `${HOST}/storage/v1/render/image/public/banners/u1/banner-1.webp?width=640&height=200&resize=cover&quality=80`
const OBJECT = `${HOST}/storage/v1/object/public/banners/u1/banner-1.webp`

describe('renderToObjectUrl', () => {
  it('maps a render URL to the object URL on the same host', () => {
    expect(renderToObjectUrl(RENDER)).toBe(OBJECT)
  })

  it('keeps non-transform query parameters', () => {
    expect(renderToObjectUrl(`${RENDER}&v=7&format=origin`)).toBe(`${OBJECT}?v=7`)
  })

  it('keeps a path prefix and encoded object names', () => {
    expect(renderToObjectUrl(`${HOST}/sb/storage/v1/render/image/public/emojis/a%20b.gif?width=48`))
      .toBe(`${HOST}/sb/storage/v1/object/public/emojis/a%20b.gif`)
  })

  it('returns null for object, signed render, relative and invalid URLs', () => {
    expect(renderToObjectUrl(OBJECT)).toBeNull()
    expect(renderToObjectUrl(`${HOST}/storage/v1/render/image/sign/media/a.png?token=t`)).toBeNull()
    expect(renderToObjectUrl('/default_avatar.webp')).toBeNull()
    expect(renderToObjectUrl('not a url')).toBeNull()
    expect(renderToObjectUrl(null)).toBeNull()
  })
})

describe('installRenderFallback', () => {
  let uninstall: () => void

  beforeEach(() => {
    uninstall = installRenderFallback(window)
  })

  afterEach(() => {
    uninstall()
    document.body.innerHTML = ''
    resetRenderFallback()
  })

  function failingImage(src: string, onElementError: () => void): HTMLImageElement {
    const img = document.createElement('img')
    img.setAttribute('src', src)
    img.addEventListener('error', onElementError)
    document.body.appendChild(img)
    return img
  }

  it('swaps a failed render URL for the object URL and hides the error from the element', () => {
    const onElementError = vi.fn()
    const img = failingImage(RENDER, onElementError)
    img.dispatchEvent(new Event('error'))
    expect(img.src).toBe(OBJECT)
    expect(onElementError).not.toHaveBeenCalled()
  })

  it('passes a failure of the object URL to the element', () => {
    const onElementError = vi.fn()
    const img = failingImage(RENDER, onElementError)
    img.dispatchEvent(new Event('error'))
    img.dispatchEvent(new Event('error'))
    expect(img.src).toBe(OBJECT)
    expect(onElementError).toHaveBeenCalledTimes(1)
  })

  it('ignores images that are not render URLs', () => {
    const onElementError = vi.fn()
    const img = failingImage('/default_avatar.webp', onElementError)
    img.dispatchEvent(new Event('error'))
    expect(img.getAttribute('src')).toBe('/default_avatar.webp')
    expect(onElementError).toHaveBeenCalledTimes(1)
  })

  it('records the failure per object, so every variant resolves to the object URL', async () => {
    const other = RENDER.replace('width=640&height=200', 'width=1280&height=400')
    const shown = computed(() => knownRenderFallback(other))
    expect(shown.value).toBe(other)
    failingImage(RENDER, vi.fn()).dispatchEvent(new Event('error'))
    await nextTick()
    expect(shown.value).toBe(OBJECT)
    expect(knownRenderFallback(OBJECT)).toBe(OBJECT)
    expect(knownRenderFallback('/default_avatar.webp')).toBe('/default_avatar.webp')
  })

  it('stops acting once uninstalled', () => {
    uninstall()
    const onElementError = vi.fn()
    const img = failingImage(RENDER, onElementError)
    img.dispatchEvent(new Event('error'))
    expect(img.src).toBe(RENDER)
    expect(onElementError).toHaveBeenCalledTimes(1)
    uninstall = () => {}
  })
})

describe('withRenderFallback', () => {
  const probes: Array<{ src: string; onerror: (() => void) | null }> = []
  const RealImage = globalThis.Image

  beforeEach(() => {
    probes.length = 0
    globalThis.Image = class {
      src = ''
      onerror: (() => void) | null = null
      constructor() {
        probes.push(this)
      }
    } as unknown as typeof Image
  })

  afterEach(() => {
    globalThis.Image = RealImage
    resetRenderFallback()
  })

  it('passes through empty, object and remote URLs without probing', () => {
    expect(withRenderFallback(null)).toBeNull()
    expect(withRenderFallback(OBJECT)).toBe(OBJECT)
    expect(withRenderFallback('blob:https://x/1')).toBe('blob:https://x/1')
    expect(probes).toHaveLength(0)
  })

  it('probes a render URL once and reports the object URL after the probe fails', async () => {
    const shown = computed(() => withRenderFallback(RENDER))
    expect(shown.value).toBe(RENDER)
    expect(withRenderFallback(RENDER)).toBe(RENDER)
    expect(probes).toHaveLength(1)
    expect(probes[0].src).toBe(RENDER)

    probes[0].onerror?.()
    await nextTick()
    expect(shown.value).toBe(OBJECT)
    expect(probes).toHaveLength(1)
  })

  it('keeps the render URL while the probe has not failed', () => {
    const shown = computed(() => withRenderFallback(RENDER))
    expect(shown.value).toBe(RENDER)
    expect(shown.value).toBe(RENDER)
    expect(probes).toHaveLength(1)
  })
})
