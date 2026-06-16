import { describe, expect, it } from 'vitest'
import {
  canonicalBannerSize,
  canonicalEmojiSize,
  canonicalSquareSize,
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
    expect(canonicalSquareSize(512)).toBe(256)
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
    expect(canonicalBannerSize(900, 300)).toEqual({ width: 1280, height: 400 })
  })
})
