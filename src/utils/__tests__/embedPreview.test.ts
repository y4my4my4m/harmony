import { describe, expect, it } from 'vitest'
import type { EmbedPayload } from '@/types'
import { isEmptyPreview, isWikimediaPage } from '../embedPreview'

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

describe('isWikimediaPage', () => {
  it('names Wikipedia and its sister projects, mobile hosts included', () => {
    expect(isWikimediaPage('https://en.wikipedia.org/wiki/Moustapha_Akkad')).toBe(true)
    expect(isWikimediaPage('https://fr.m.wikipedia.org/wiki/Paris')).toBe(true)
    expect(isWikimediaPage('https://commons.wikimedia.org/wiki/File:X.gif')).toBe(true)
    expect(isWikimediaPage('https://en.wiktionary.org/wiki/gif')).toBe(true)
  })

  it('nothing else', () => {
    expect(isWikimediaPage('https://tenor.com/view/cat')).toBe(false)
    expect(isWikimediaPage('https://notwikipedia.org/wiki/x')).toBe(false)
    expect(isWikimediaPage('https://wikipedia.org.evil.example/wiki/x')).toBe(false)
    expect(isWikimediaPage('not a url')).toBe(false)
    expect(isWikimediaPage(undefined)).toBe(false)
  })
})
