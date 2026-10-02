import { describe, expect, it } from 'vitest'
import { buildGifMessageUrl, parseKlipyItemPageUrl } from '../klipyAttribution'

describe('parseKlipyItemPageUrl', () => {
  it('returns an http(s) item page', () => {
    const url = buildGifMessageUrl('https://static.klipy.com/a.gif', { itemPageUrl: 'https://klipy.com/gifs/a' })
    expect(parseKlipyItemPageUrl(url)).toBe('https://klipy.com/gifs/a')
  })

  it('refuses a sender-controlled script or data URL', () => {
    for (const item of ['javascript:alert(document.cookie)', ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x']) {
      const url = buildGifMessageUrl('https://static.klipy.com/a.gif', { itemPageUrl: item })
      expect(parseKlipyItemPageUrl(url), item).toBeNull()
    }
  })
})
