import { describe, it, expect, vi } from 'vitest'

vi.stubGlobal('import', { meta: { env: { VITE_DOMAIN: 'harmony.test', VITE_HARMONY_ALT_DOMAINS: 'alt.harmony.test' } } })

// Must re-mock import.meta.env before importing the module
vi.mock('@/types', () => ({}))

// We need to test the functions in isolation. Since embedDetection.ts reads
// import.meta.env at module load time, we mock it via the setup file.
import {
  normalizeEmbedUrl,
  parseEmbedUrl,
  isYouTubeUrl,
  isSpotifyUrl,
  extractYouTubeId,
  buildYouTubeEmbedUrl,
  buildSpotifyEmbedUrl,
} from '@/utils/embedDetection'

describe('embedDetection', () => {
  describe('normalizeEmbedUrl', () => {
    it('returns null for empty string', () => {
      expect(normalizeEmbedUrl('')).toBe(null)
    })

    it('returns null for invalid URL', () => {
      expect(normalizeEmbedUrl('not a url at all!!!')).toBe(null)
    })

    it('adds https:// when no protocol is specified', () => {
      const result = normalizeEmbedUrl('youtube.com/watch?v=abc123')
      expect(result).toMatch(/^https:\/\/youtube\.com/)
    })

    it('lowercases the hostname', () => {
      const result = normalizeEmbedUrl('https://YouTube.COM/watch?v=abc')
      expect(result).toContain('youtube.com')
    })

    it('strips default port 443 for https', () => {
      const result = normalizeEmbedUrl('https://example.com:443/path')
      expect(result).not.toContain(':443')
    })

    it('strips default port 80 for http', () => {
      const result = normalizeEmbedUrl('http://example.com:80/path')
      expect(result).not.toContain(':80')
    })

    it('preserves non-default port', () => {
      const result = normalizeEmbedUrl('https://example.com:8080/path')
      expect(result).toContain(':8080')
    })

    it('trims whitespace', () => {
      const result = normalizeEmbedUrl('  https://example.com  ')
      expect(result).toBe('https://example.com/')
    })
  })

  describe('parseEmbedUrl', () => {
    it('returns a URL object for valid input', () => {
      const url = parseEmbedUrl('https://example.com/path')
      expect(url).toBeInstanceOf(URL)
      expect(url!.pathname).toBe('/path')
    })

    it('returns null for invalid input', () => {
      expect(parseEmbedUrl('')).toBe(null)
    })
  })

  describe('isYouTubeUrl', () => {
    it.each([
      ['https://youtube.com/watch?v=abc', true],
      ['https://www.youtube.com/watch?v=abc', true],
      ['https://m.youtube.com/watch?v=abc', true],
      ['https://youtu.be/abc', true],
      ['https://vimeo.com/123', false],
      ['https://example.com', false],
    ])('isYouTubeUrl(%s) === %s', (input, expected) => {
      const url = new URL(input)
      expect(isYouTubeUrl(url)).toBe(expected)
    })
  })

  describe('isSpotifyUrl', () => {
    it('detects open.spotify.com', () => {
      expect(isSpotifyUrl(new URL('https://open.spotify.com/track/123'))).toBe(true)
    })

    it('rejects non-spotify domains', () => {
      expect(isSpotifyUrl(new URL('https://example.com'))).toBe(false)
    })
  })

  describe('extractYouTubeId', () => {
    it('extracts from youtu.be short link', () => {
      expect(extractYouTubeId(new URL('https://youtu.be/dQw4w9WgXcQ'))).toBe('dQw4w9WgXcQ')
    })

    it('extracts from /watch?v= format', () => {
      expect(extractYouTubeId(new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))).toBe('dQw4w9WgXcQ')
    })

    it('extracts from /shorts/ format', () => {
      expect(extractYouTubeId(new URL('https://youtube.com/shorts/abc123'))).toBe('abc123')
    })

    it('extracts from /embed/ format', () => {
      expect(extractYouTubeId(new URL('https://youtube.com/embed/abc123'))).toBe('abc123')
    })

    it('extracts from /live/ format', () => {
      expect(extractYouTubeId(new URL('https://youtube.com/live/abc123'))).toBe('abc123')
    })

    it('returns null for non-youtube URL', () => {
      expect(extractYouTubeId(new URL('https://example.com'))).toBe(null)
    })
  })

  describe('buildYouTubeEmbedUrl', () => {
    it('builds embed URL from standard watch URL', () => {
      const url = new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
      expect(buildYouTubeEmbedUrl(url)).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ')
    })

    it('includes start time from ?t= parameter (seconds)', () => {
      const url = new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90')
      expect(buildYouTubeEmbedUrl(url)).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ?start=90')
    })

    it('includes start time from ?t= parameter (h/m/s format)', () => {
      const url = new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m30s')
      expect(buildYouTubeEmbedUrl(url)).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ?start=3750')
    })

    it('returns null when video ID cannot be extracted', () => {
      const url = new URL('https://youtube.com/channel/someChannel')
      expect(buildYouTubeEmbedUrl(url)).toBe(null)
    })
  })

  describe('buildSpotifyEmbedUrl', () => {
    it('builds embed URL from track URL', () => {
      const url = new URL('https://open.spotify.com/track/abc123')
      expect(buildSpotifyEmbedUrl(url)).toBe('https://open.spotify.com/embed/track/abc123')
    })

    it('builds embed URL from album URL', () => {
      const url = new URL('https://open.spotify.com/album/xyz789')
      expect(buildSpotifyEmbedUrl(url)).toBe('https://open.spotify.com/embed/album/xyz789')
    })

    it('returns null for non-spotify URL', () => {
      const url = new URL('https://example.com/track/123')
      expect(buildSpotifyEmbedUrl(url)).toBe(null)
    })

    it('returns null when path has insufficient segments', () => {
      const url = new URL('https://open.spotify.com/')
      expect(buildSpotifyEmbedUrl(url)).toBe(null)
    })
  })
})
