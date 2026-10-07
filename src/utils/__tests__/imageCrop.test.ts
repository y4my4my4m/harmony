import { afterEach, describe, expect, it, vi } from 'vitest'
import { clampCrop, initialCrop } from '@/utils/cropGeometry'
import {
  CROP_PRESETS,
  encodeCropOutput,
  exportCrop,
  inspectImageFile,
  loadCropSource,
  renderCropPreview,
} from '@/utils/imageCrop'
import type { ImageCodec } from '@/utils/imageResize'

// 2×2 files written by Pillow 12.3: red, and red then blue for the two-frame ones.
const FIXTURES = {
  gifStatic: 'R0lGODdhAgACAIEAAP8AAAAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7',
  gifAnimated: 'R0lGODlhAgACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQBCgABACwAAAAAAgACAIEAAP8AAAAAAAAAAAAIBgABCAQQEAA7',
  pngStatic: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  apng: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAACAAAAAgAAAAAAAAAAAAEACgAA6FTcAAAAABZJREFUeJxj/M/AwMDAwMTAwMDAwAAADR0BA2rCm+kAAAAaZmNUTAAAAAEAAAACAAAAAgAAAAAAAAAAAAEACgAAcyc21AAAABpmZEFUAAAAAnicY2Rg+M/AwMDEwMDAwMAAAAsfAQM5oA0PAAAAAElFTkSuQmCC',
  webpStatic: 'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=',
  webpAlpha: 'UklGRlwAAABXRUJQVlA4WAoAAAAQAAAAAQAAAQAAQUxQSAUAAAAAgICAgABWUDggMAAAANABAJ0BKgIAAgABQCYloAJ0ugH4AAOwAP7y63/82BXNc+/3/9Lg/S4P0uD/0pAAAA==',
  webpAnimated: 'UklGRsQAAABXRUJQVlA4WAoAAAACAAAAAQAAAQAAQU5JTQYAAAAAAAAAAABBTk1GSgAAAAAAAAAAAAEAAAEAAGQAAAJWUDggMgAAADABAJ0BKgIAAgABQCYloAADcAD+8ut///mwP/bz/wR6Af//0uD//pcH//S4P/SkAAAAQU5NRkYAAAAAAAAAAAABAAABAABkAAAAVlA4IC4AAAA0AQCdASoCAAIAAAAmJaAAA3AA/vtV4///S4P/+lwf/9Lg/9Lg//rV5Vesq6AA',
} as const

function fixture(name: keyof typeof FIXTURES, fileName: string, type = ''): File {
  const bytes = Uint8Array.from(atob(FIXTURES[name]), (c) => c.charCodeAt(0))
  return new File([bytes], fileName, { type })
}

describe('inspectImageFile: animation from the bytes', () => {
  it('GIF: more than one image descriptor', async () => {
    expect(await inspectImageFile(fixture('gifAnimated', 'a.gif'))).toEqual({ format: 'gif', animated: true })
    expect(await inspectImageFile(fixture('gifStatic', 'a.gif'))).toEqual({ format: 'gif', animated: false })
  })

  it('APNG: an acTL chunk', async () => {
    expect(await inspectImageFile(fixture('apng', 'a.png'))).toEqual({ format: 'png', animated: true })
    expect(await inspectImageFile(fixture('pngStatic', 'a.png'))).toEqual({ format: 'png', animated: false })
  })

  it('WebP: an ANIM chunk', async () => {
    expect(await inspectImageFile(fixture('webpAnimated', 'a.webp'))).toEqual({ format: 'webp', animated: true })
    expect(await inspectImageFile(fixture('webpStatic', 'a.webp'))).toEqual({ format: 'webp', animated: false })
    expect(await inspectImageFile(fixture('webpAlpha', 'a.webp'))).toEqual({ format: 'webp', animated: false })
  })

  it('ignores the name and declared type', async () => {
    expect(await inspectImageFile(fixture('gifAnimated', 'photo.jpg', 'image/jpeg'))).toEqual({ format: 'gif', animated: true })
    expect(await inspectImageFile(fixture('pngStatic', 'anim.gif', 'image/gif'))).toEqual({ format: 'png', animated: false })
  })
})

describe('encodeCropOutput', () => {
  const blob = (type: string) => new Blob(['x'], { type })

  it('prefers WebP for opaque pixels', async () => {
    const encode = vi.fn(async (type: string) => blob(type))
    expect(await encodeCropOutput(encode, false)).toMatchObject({ type: 'image/webp', extension: 'webp' })
    expect(encode).toHaveBeenCalledWith('image/webp', 0.9)
  })

  it('falls back to JPEG where WebP encoding returns PNG (WebKit)', async () => {
    const encode = vi.fn(async (type: string) => blob(type === 'image/webp' ? 'image/png' : type))
    expect(await encodeCropOutput(encode, false)).toMatchObject({ type: 'image/jpeg', extension: 'jpg' })
  })

  it('keeps PNG for transparency', async () => {
    const encode = vi.fn(async (type: string) => blob(type))
    expect(await encodeCropOutput(encode, true)).toMatchObject({ type: 'image/png', extension: 'png' })
    expect(encode).toHaveBeenCalledTimes(1)
  })
})

interface DrawCall {
  args: unknown[]
  transform: string[]
}

/** OffscreenCanvas stand-in recording the 2D calls; getImageData reports `alpha` for every pixel. */
function installFakeCanvas(alpha = 255) {
  const draws: DrawCall[] = []
  const sizes: Array<{ width: number; height: number }> = []
  class FakeCanvas {
    constructor(public width: number, public height: number) {
      sizes.push({ width, height })
    }
    getContext() {
      const transform: string[] = []
      const canvas = this
      return {
        canvas,
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low',
        translate: (x: number, y: number) => transform.push(`translate(${x},${y})`),
        rotate: (r: number) => transform.push(`rotate(${Math.round((r * 180) / Math.PI)})`),
        setTransform: (...m: number[]) => transform.push(`matrix(${m.map((v) => Math.round(v * 1000) / 1000 + 0).join(',')})`),
        drawImage: (...args: unknown[]) => draws.push({ args, transform: [...transform] }),
        getImageData: (_x: number, _y: number, w: number, h: number) => {
          const data = new Uint8ClampedArray(w * h * 4)
          for (let i = 3; i < data.length; i += 4) data[i] = alpha
          return { data }
        },
      }
    }
    convertToBlob({ type }: { type: string }) {
      return Promise.resolve(new Blob(['encoded'], { type }))
    }
  }
  vi.stubGlobal('OffscreenCanvas', FakeCanvas)
  return { draws, sizes }
}

describe('exportCrop', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const image = { id: 'bitmap' }
  const source = { image: image as unknown as CanvasImageSource, width: 1200, height: 800, format: 'jpeg' as const }

  it('draws the computed source rect into the fixed avatar size and names the file by its format', async () => {
    const { draws, sizes } = installFakeCanvas()
    const state = { ...initialCrop(source), zoom: 2 }
    const file = await exportCrop(source, state, 1, CROP_PRESETS.avatar.output, 'me.jpeg')
    expect(sizes[0]).toEqual({ width: 400, height: 400 })
    expect(draws[0].args).toEqual([image, 400, 200, 400, 400, -200, -200, 400, 400])
    expect(draws[0].transform).toEqual(['translate(200,200)', 'rotate(0)'])
    expect(file?.name).toBe('me.webp')
    expect(file?.type).toBe('image/webp')
  })

  it('scales to the target when the crop has more pixels', async () => {
    const { draws, sizes } = installFakeCanvas()
    const big = { ...source, width: 3000, height: 2000 }
    await exportCrop(big, initialCrop(big), 3, CROP_PRESETS.profile_banner.output, 'b.png')
    expect(sizes[0]).toEqual({ width: 1500, height: 500 })
    expect(draws[0].args.slice(1)).toEqual([0, 500, 3000, 1000, -750, -250, 1500, 500])
  })

  it('rotates a quarter turn with the destination box swapped', async () => {
    const { draws, sizes } = installFakeCanvas()
    const state = clampCrop({ rotation: 90, zoom: 1, cx: 0, cy: 0 }, source, 2)
    await exportCrop(source, state, 2, null, 'r.jpg')
    // Turned image is 800×1200: a 2:1 crop at the top is 800×400 and comes from the source's left edge.
    expect(sizes[0]).toEqual({ width: 800, height: 400 })
    expect(draws[0].args.slice(1)).toEqual([0, 0, 400, 800, -200, -400, 400, 800])
    expect(draws[0].transform).toEqual(['translate(400,200)', 'rotate(90)'])
  })

  it('keeps PNG when a format that carries alpha has transparent pixels', async () => {
    installFakeCanvas(128)
    const file = await exportCrop({ ...source, format: 'png' }, initialCrop(source), 1, { width: 512, height: 512 }, 'logo.png')
    expect(file?.type).toBe('image/png')
    expect(file?.name).toBe('logo.png')
  })

  it('does not scan JPEG sources for alpha', async () => {
    installFakeCanvas(0)
    const file = await exportCrop(source, initialCrop(source), 1, { width: 512, height: 512 }, 'p.jpg')
    expect(file?.type).toBe('image/webp')
  })

  it('renders a preview of the crop from the preview copy', async () => {
    const { draws, sizes } = installFakeCanvas()
    const preview = { id: 'preview' }
    const blob = await renderCropPreview({ ...source, preview: preview as unknown as CanvasImageSource }, initialCrop(source), 1.5)
    expect(sizes[0]).toEqual({ width: 720, height: 480 })
    expect(draws[0].args).toEqual([preview, 0, 0, 1200, 800])
    expect(blob?.type).toBe('image/webp')
  })
})

describe('loadCropSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the decoder output when it already applied the EXIF orientation', async () => {
    const close = vi.fn()
    const codec: ImageCodec = {
      decode: async () => ({ width: 20, height: 10, source: {} as CanvasImageSource, close }),
      appliesOrientation: async () => true,
      render: () => null,
    }
    const loaded = await loadCropSource(fixture('pngStatic', 'a.png'), codec)
    expect(loaded).toMatchObject({ width: 20, height: 10, format: 'png' })
    loaded?.close()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('is null when the engine cannot decode the file', async () => {
    const codec: ImageCodec = {
      decode: async () => null,
      appliesOrientation: async () => true,
      render: () => null,
    }
    expect(await loadCropSource(fixture('pngStatic', 'a.png'), codec)).toBeNull()
  })
})
