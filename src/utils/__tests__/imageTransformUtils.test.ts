import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bannerRenderSize,
  canonicalBannerSize,
  canonicalEmojiSize,
  canonicalSquareSize,
  devicePixels,
} from '@/utils/imageTransformUtils'

describe('canonicalSquareSize', () => {
  it('snaps reaction/tooltip/picker sizes to shared variants', () => {
    expect(canonicalSquareSize(20)).toBe(32)
    expect(canonicalSquareSize(32)).toBe(32)
    expect(canonicalSquareSize(42)).toBe(64)
    expect(canonicalSquareSize(48)).toBe(64)
    expect(canonicalSquareSize(96)).toBe(128)
    expect(canonicalSquareSize(128)).toBe(128)
    expect(canonicalSquareSize(256)).toBe(256)
    expect(canonicalSquareSize(300)).toBe(512)
    expect(canonicalSquareSize(1024)).toBe(512)
  })
})

describe('canonicalEmojiSize', () => {
  it('collapses chip and tooltip requests to the same variant', () => {
    expect(canonicalEmojiSize(32)).toBe(64)
    expect(canonicalEmojiSize(48)).toBe(64)
    expect(canonicalEmojiSize(96)).toBe(128)
  })
})

describe('canonicalBannerSize', () => {
  it('snaps banner dimensions independently', () => {
    expect(canonicalBannerSize(480, 140)).toEqual({ width: 480, height: 140 })
    expect(canonicalBannerSize(640, 200)).toEqual({ width: 640, height: 200 })
    expect(canonicalBannerSize(640, 350)).toEqual({ width: 640, height: 400 })
    expect(canonicalBannerSize(900, 300)).toEqual({ width: 960, height: 400 })
    expect(canonicalBannerSize(4000, 2000)).toEqual({ width: 2560, height: 1440 })
  })
})

describe('devicePixels', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('scales CSS pixels by devicePixelRatio, clamped to 1–3', () => {
    vi.stubGlobal('devicePixelRatio', 2)
    expect(devicePixels(48)).toBe(96)
    vi.stubGlobal('devicePixelRatio', 1.5)
    expect(devicePixels(48)).toBe(72)
    vi.stubGlobal('devicePixelRatio', 0.5)
    expect(devicePixels(48)).toBe(48)
    vi.stubGlobal('devicePixelRatio', 4)
    expect(devicePixels(48)).toBe(144)
  })

  it('repeats one banner variant per display size and ratio', () => {
    vi.stubGlobal('devicePixelRatio', 1)
    expect(bannerRenderSize(420, 100)).toEqual({ width: 480, height: 140 })
    vi.stubGlobal('devicePixelRatio', 2)
    expect(bannerRenderSize(420, 100)).toEqual({ width: 960, height: 200 })
    expect(bannerRenderSize(400, 110)).toEqual({ width: 960, height: 280 })
  })
})
