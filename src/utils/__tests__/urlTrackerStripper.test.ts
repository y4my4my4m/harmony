import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stripTrackingParameters, stripUrlsInText } from '@/utils/urlTrackerStripper'

describe('urlTrackerStripper', () => {
  describe('stripTrackingParameters', () => {
    it('strips YouTube si param', () => {
      const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc123'
      const cleaned = stripTrackingParameters(url)
      expect(cleaned).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    })

    it('strips YouTube utm_source param', () => {
      const url = 'https://www.youtube.com/watch?v=abc&utm_source=share'
      const cleaned = stripTrackingParameters(url)
      expect(cleaned).toBe('https://www.youtube.com/watch?v=abc')
    })

    it('strips youtu.be si param', () => {
      const url = 'https://youtu.be/dQw4w9WgXcQ?si=abc123'
      const cleaned = stripTrackingParameters(url)
      expect(cleaned).toBe('https://youtu.be/dQw4w9WgXcQ')
    })

    it('strips X/Twitter tracking params', () => {
      const url = 'https://x.com/user/status/123?s=20&t=abc'
      const cleaned = stripTrackingParameters(url)
      expect(cleaned).toBe('https://x.com/user/status/123')
    })

    it('strips Twitter legacy domain', () => {
      const url = 'https://twitter.com/user/status/123?s=20&t=abc&ref_src=twsrc'
      const cleaned = stripTrackingParameters(url)
      expect(cleaned).toBe('https://twitter.com/user/status/123')
    })

    it('strips TikTok tracking params', () => {
      const url = 'https://tiktok.com/@user/video/123?is_from_webapp=1&sender_device=pc'
      const cleaned = stripTrackingParameters(url)
      expect(cleaned).toBe('https://tiktok.com/@user/video/123')
    })

    it('strips Instagram igshid param', () => {
      const url = 'https://www.instagram.com/p/abc123/?igshid=xyz'
      const cleaned = stripTrackingParameters(url)
      expect(cleaned).toBe('https://www.instagram.com/p/abc123/')
    })

    it('strips Facebook fbclid param', () => {
      const url = 'https://www.facebook.com/post/123?fbclid=abc'
      const cleaned = stripTrackingParameters(url)
      expect(cleaned).toBe('https://www.facebook.com/post/123')
    })

    it('leaves unknown domains unchanged', () => {
      const url = 'https://example.com/page?foo=bar'
      expect(stripTrackingParameters(url)).toBe(url)
    })

    it('preserves non-tracking params', () => {
      const url = 'https://www.youtube.com/watch?v=abc&t=120&si=xyz'
      const cleaned = stripTrackingParameters(url)
      expect(cleaned).toContain('v=abc')
      expect(cleaned).toContain('t=120')
      expect(cleaned).not.toContain('si=')
    })

    it('removes trailing ? when all params are stripped', () => {
      const url = 'https://youtu.be/abc?si=xyz'
      const cleaned = stripTrackingParameters(url)
      expect(cleaned).not.toMatch(/\?$/)
    })

    it('returns original for invalid URL', () => {
      expect(stripTrackingParameters('not a url')).toBe('not a url')
    })
  })

  describe('stripUrlsInText', () => {
    beforeEach(() => {
      // Mock localStorage for isUrlTrackingStrippingEnabled
      vi.stubGlobal('localStorage', {
        getItem: vi.fn().mockReturnValue('true'),
        setItem: vi.fn(),
      })
    })

    it('strips tracking params from URLs in text', () => {
      const text = 'Check this out: https://youtu.be/abc?si=xyz and more text'
      const cleaned = stripUrlsInText(text)
      expect(cleaned).toBe('Check this out: https://youtu.be/abc and more text')
    })

    it('handles multiple URLs in text', () => {
      const text = 'https://youtu.be/a?si=1 and https://x.com/status/1?s=20'
      const cleaned = stripUrlsInText(text)
      expect(cleaned).not.toContain('si=')
      expect(cleaned).not.toContain('s=20')
    })

    it('returns empty string for empty input', () => {
      expect(stripUrlsInText('')).toBe('')
    })

    it('returns text unchanged when no URLs present', () => {
      const text = 'just some regular text'
      expect(stripUrlsInText(text)).toBe(text)
    })
  })
})
