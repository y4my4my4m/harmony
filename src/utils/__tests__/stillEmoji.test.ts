import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const FRAME = 'blob:still-frame'
let createdImages: Array<{ crossOrigin: string | null; src: string; onload?: () => void; onerror?: () => void }> = []

class FakeImage {
  crossOrigin: string | null = null
  naturalWidth = 96
  naturalHeight = 96
  onload?: () => void
  onerror?: () => void
  private value = ''
  get src() { return this.value }
  set src(next: string) {
    this.value = next
    createdImages.push(this)
  }
}

describe('stillEmoji', () => {
  let setEmojiStill: (on: boolean) => void

  beforeEach(async () => {
    vi.resetModules()
    createdImages = []
    const module = await import('@/utils/stillEmoji')
    setEmojiStill = module.setEmojiStill
    vi.stubGlobal('Image', FakeImage)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = Document.prototype.createElement.call(document, tag)
      if (tag === 'canvas') {
        Object.assign(el, {
          getContext: () => ({ drawImage: () => {} }),
          toBlob: (done: (b: Blob) => void) => done(new Blob(['x'])),
        })
      }
      return el
    }) as typeof document.createElement)
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => FRAME }))
  })

  afterEach(() => {
    setEmojiStill(false)
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const emoji = (src: string, cls = 'emoji-icon') => {
    const img = document.createElement('img')
    img.className = cls
    img.setAttribute('src', src)
    document.body.appendChild(img)
    return img
  }

  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  it('swaps a loaded emoji for its first frame and back', async () => {
    setEmojiStill(true)
    const src = 'https://cdn.example/party.gif'
    const img = emoji(src)
    img.dispatchEvent(new Event('load'))
    await settle()
    expect(createdImages[0].crossOrigin).toBe('anonymous')
    createdImages[0].onload?.()
    await settle()
    expect(img.getAttribute('src')).toBe(FRAME)
    setEmojiStill(false)
    expect(img.getAttribute('src')).toBe(src)
  })

  it('leaves an emoji animating when its host refuses CORS', async () => {
    setEmojiStill(true)
    const src = 'https://no-cors.example/party.gif'
    const img = emoji(src)
    img.dispatchEvent(new Event('load'))
    await settle()
    createdImages[0].onerror?.()
    await settle()
    expect(img.getAttribute('src')).toBe(src)
  })

  it('draws the same source once', async () => {
    setEmojiStill(true)
    const src = 'https://cdn.example/once.gif'
    emoji(src).dispatchEvent(new Event('load'))
    emoji(src).dispatchEvent(new Event('load'))
    await settle()
    expect(createdImages).toHaveLength(1)
  })

  it('takes the .png of an animated Discord emoji, with no canvas', async () => {
    setEmojiStill(true)
    const img = emoji('https://cdn.discordapp.com/emojis/123456789012345678.gif')
    img.dispatchEvent(new Event('load'))
    await settle()
    expect(createdImages).toHaveLength(0)
    expect(img.getAttribute('src')).toBe('https://cdn.discordapp.com/emojis/123456789012345678.png')
    img.dispatchEvent(new Event('load'))
    await settle()
    expect(img.getAttribute('src')).toBe('https://cdn.discordapp.com/emojis/123456789012345678.png')
    setEmojiStill(false)
    expect(img.getAttribute('src')).toBe('https://cdn.discordapp.com/emojis/123456789012345678.gif')
  })

  it('skips vector packs and images that are not emoji', async () => {
    setEmojiStill(true)
    emoji('/assets/twemoji/1f600.svg', 'inline-emoji').dispatchEvent(new Event('load'))
    emoji('https://x.example/photo.gif', 'photo').dispatchEvent(new Event('load'))
    await settle()
    expect(createdImages).toHaveLength(0)
  })

  it('freezes emoji already on the page when turned on', async () => {
    const img = emoji('https://cdn.example/already.gif')
    Object.defineProperty(img, 'complete', { value: true })
    setEmojiStill(true)
    await settle()
    expect(createdImages).toHaveLength(1)
  })
})
