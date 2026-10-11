import { describe, expect, it } from 'vitest'
import type { EmbedPayload } from '@/types'
import { isEmptyPreview } from '../embedPreview'

const base = (over: Partial<EmbedPayload>): EmbedPayload => ({
  cacheKey: 'k', url: 'https://q3.example/', normalizedUrl: 'https://q3.example/', provider: 'generic',
  fetchedAt: '', expiresAt: '', ...over,
} as EmbedPayload)

describe('isEmptyPreview', () => {
  it('hides failed previews, including ones stored with the error as description', () => {
    expect(isEmptyPreview(base({ failed: true, title: 'Quake' }))).toBe(true)
    expect(isEmptyPreview(base({ title: 'https://q3.example/', description: 'This operation was aborted' }))).toBe(true)
    expect(isEmptyPreview(base({ title: '' }))).toBe(true)
  })

  it('keeps previews that say something', () => {
    expect(isEmptyPreview(base({ title: 'Quake III in the browser' }))).toBe(false)
    expect(isEmptyPreview(base({ title: 'https://q3.example/', image: 'https://q3.example/og.png' }))).toBe(false)
    expect(isEmptyPreview(base({ title: 'x.example', video: { url: 'https://cdn.example/clip.mp4' }, mediaOnly: true }))).toBe(false)
    expect(isEmptyPreview(base({ provider: 'youtube', title: 'https://q3.example/' }))).toBe(false)
  })
})
