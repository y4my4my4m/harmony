import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stripTrackingParameters, stripUrlsInText } from '@/utils/urlTrackerStripper'

describe('urlTrackerStripper', () => {
  describe('stripTrackingParameters (domain-specific)', () => {
    it('strips YouTube si param', () => {
      const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc123'
      expect(stripTrackingParameters(url)).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    })

    it('strips youtu.be si param', () => {
      const url = 'https://youtu.be/dQw4w9WgXcQ?si=abc123'
      expect(stripTrackingParameters(url)).toBe('https://youtu.be/dQw4w9WgXcQ')
    })

    it('strips Spotify share ids and keeps the playing context', () => {
      expect(stripTrackingParameters('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=a1b2c3d4e5f6&nd=1&dlsi=0f9e'))
        .toBe('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC')
      expect(stripTrackingParameters('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?context=spotify%3Aplaylist%3A37i9dQZF1DX&si=abc'))
        .toBe('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?context=spotify%3Aplaylist%3A37i9dQZF1DX')
    })

    it('strips SoundCloud and YouTube Music share ids', () => {
      expect(stripTrackingParameters('https://soundcloud.com/artist/track?si=0123abcd&utm_source=clipboard&utm_medium=text'))
        .toBe('https://soundcloud.com/artist/track')
      expect(stripTrackingParameters('https://music.youtube.com/watch?v=abcdefghijk&si=xyz'))
        .toBe('https://music.youtube.com/watch?v=abcdefghijk')
    })

    it('leaves si on hosts that did not opt in', () => {
      expect(stripTrackingParameters('https://example.com/page?si=1')).toBe('https://example.com/page?si=1')
    })

    it('strips X/Twitter share signature (s, t)', () => {
      const url = 'https://x.com/user/status/123?s=20&t=abc'
      expect(stripTrackingParameters(url)).toBe('https://x.com/user/status/123')
    })

    it('strips Twitter ref_src + ref_url', () => {
      const url = 'https://twitter.com/user/status/123?s=20&t=abc&ref_src=twsrc'
      expect(stripTrackingParameters(url)).toBe('https://twitter.com/user/status/123')
    })

    it('strips TikTok share metadata', () => {
      const url = 'https://tiktok.com/@user/video/123?is_from_webapp=1&sender_device=pc'
      expect(stripTrackingParameters(url)).toBe('https://tiktok.com/@user/video/123')
    })

    it('strips Instagram igshid param', () => {
      const url = 'https://www.instagram.com/p/abc123/?igshid=xyz'
      expect(stripTrackingParameters(url)).toBe('https://www.instagram.com/p/abc123/')
    })

    it('strips Facebook fbclid + ref', () => {
      const url = 'https://www.facebook.com/post/123?fbclid=abc&ref=foo'
      expect(stripTrackingParameters(url)).toBe('https://www.facebook.com/post/123')
    })
  })

  describe('stripTrackingParameters (post links on embed-fixer mirrors)', () => {
    it.each([
      ['kkinstagram.com', 'https://kkinstagram.com/reel/De-YBL8zRXm/?mdxt=MXN0Z2w5YWF3c2U1eg==', 'https://kkinstagram.com/reel/De-YBL8zRXm/'],
      ['eeinstagram.com', 'https://eeinstagram.com/p/C0fQuIUJ875/?igsh=MWZ5dDlkd3lqNXQ5Mg==&mdxt=MXN0Z2w5YWF3c2U1eg==', 'https://eeinstagram.com/p/C0fQuIUJ875/'],
      ['www.ddinstagram.com', 'https://www.ddinstagram.com/reel/De-YBL8zRXm/?igshid=x&utm_source=ig_web_copy_link', 'https://www.ddinstagram.com/reel/De-YBL8zRXm/'],
      ['fixupx.com', 'https://fixupx.com/NASA/status/2112560723603632217?s=46&t=AbCdEf', 'https://fixupx.com/NASA/status/2112560723603632217'],
      ['vxtwitter.com', 'https://vxtwitter.com/NASA/status/1?ref_src=twsrc%5Etfw&ref_url=https%3A%2F%2Fexample.com', 'https://vxtwitter.com/NASA/status/1'],
      ['fxtwitter.com', 'https://fxtwitter.com/NASA/status/1?s=20', 'https://fxtwitter.com/NASA/status/1'],
      ['fxbsky.app', 'https://fxbsky.app/profile/bsky.app/post/3mxyyerrxak2m?ref_src=embed', 'https://fxbsky.app/profile/bsky.app/post/3mxyyerrxak2m'],
      ['bskye.app', 'https://bskye.app/profile/bsky.app/post/3mx?ref_src=embed&utm_medium=share', 'https://bskye.app/profile/bsky.app/post/3mx'],
    ])('strips the share trackers of the site on %s', (_host, sent, stored) => {
      expect(stripTrackingParameters(sent)).toBe(stored)
    })

    it('strips Instagram mdxt on the site itself and keeps the carousel index', () => {
      expect(stripTrackingParameters('https://www.instagram.com/p/C0fQuIUJ875/?img_index=3&mdxt=MXN0Z2w5YWF3c2U1eg==&igsh=x'))
        .toBe('https://www.instagram.com/p/C0fQuIUJ875/?img_index=3')
    })

    it('strips X share tokens on mobile.twitter.com and leaves the X search query', () => {
      expect(stripTrackingParameters('https://mobile.twitter.com/jack/status/20?s=21')).toBe('https://mobile.twitter.com/jack/status/20')
      expect(stripTrackingParameters('https://x.com/search?q=launch&src=typed_query')).toBe('https://x.com/search?q=launch&src=typed_query')
    })

    it('leaves the site-only names on other hosts', () => {
      expect(stripTrackingParameters('https://example.com/a?mdxt=1&s=2&t=3&ref_src=4')).toBe('https://example.com/a?mdxt=1&s=2&t=3&ref_src=4')
      expect(stripTrackingParameters('https://notkkinstagram.com/reel/x/?mdxt=1')).toBe('https://notkkinstagram.com/reel/x/?mdxt=1')
    })

    it('leaves Klipy URLs as Klipy returned them', () => {
      const media = 'https://static.klipy.com/ii/abc/de/fg/cat.gif?utm_source=partner&fbclid=1'
      expect(stripTrackingParameters(media)).toBe(media)
      expect(stripTrackingParameters('https://klipy.com/gifs/cat?utm_source=x')).toBe('https://klipy.com/gifs/cat?utm_source=x')
    })
  })

  describe('stripTrackingParameters (universal utm_*)', () => {
    it('strips utm_* from any domain', () => {
      const url = 'https://arstechnica.com/science/article/?utm_brand=arstechnica&utm_social-type=owned&utm_source=mastodon&utm_medium=social'
      expect(stripTrackingParameters(url)).toBe('https://arstechnica.com/science/article/')
    })

    it('strips utm_id, utm_term, utm_content even on unknown domains', () => {
      const url = 'https://example.com/x?utm_id=1&utm_term=foo&utm_content=bar&keep=yes'
      expect(stripTrackingParameters(url)).toBe('https://example.com/x?keep=yes')
    })

    it('strips Matomo pk_* params', () => {
      const url = 'https://example.com/x?pk_campaign=foo&pk_source=bar&pk_medium=baz&legit=1'
      expect(stripTrackingParameters(url)).toBe('https://example.com/x?legit=1')
    })

    it('strips Matomo new-style mtm_* params', () => {
      const url = 'https://example.com/x?mtm_campaign=foo&keep=1'
      expect(stripTrackingParameters(url)).toBe('https://example.com/x?keep=1')
    })

    it('strips HubSpot ads hsa_* params', () => {
      const url = 'https://example.com/x?hsa_acc=123&hsa_grp=456&legit=ok'
      expect(stripTrackingParameters(url)).toBe('https://example.com/x?legit=ok')
    })
  })

  describe('stripTrackingParameters (universal click IDs)', () => {
    it('strips Google Ads gclid / gbraid / wbraid / dclid', () => {
      const url = 'https://example.com/x?gclid=a&gbraid=b&wbraid=c&dclid=d&keep=1'
      expect(stripTrackingParameters(url)).toBe('https://example.com/x?keep=1')
    })

    it('strips fbclid on any domain', () => {
      const url = 'https://news.example.org/?fbclid=foo'
      expect(stripTrackingParameters(url)).toBe('https://news.example.org/')
    })

    it('strips Microsoft / Yandex / Twitter / TikTok / Snapchat / Meta click IDs', () => {
      const url = 'https://example.com/x?msclkid=a&yclid=b&twclid=c&ttclid=d&scid=e&mibextid=f&keep=z'
      expect(stripTrackingParameters(url)).toBe('https://example.com/x?keep=z')
    })

    it('strips Instagram cross-app share params (igshid, igsh)', () => {
      const url = 'https://anywhere.example.com/?igshid=a&igsh=b'
      expect(stripTrackingParameters(url)).toBe('https://anywhere.example.com/')
    })
  })

  describe('stripTrackingParameters (universal email/CRM)', () => {
    it('strips Mailchimp mc_eid / mc_cid', () => {
      const url = 'https://example.com/x?mc_eid=a&mc_cid=b&keep=1'
      expect(stripTrackingParameters(url)).toBe('https://example.com/x?keep=1')
    })

    it('strips HubSpot _hsenc / _hsmi / _hsfp', () => {
      const url = 'https://example.com/x?_hsenc=a&_hsmi=b&_hsfp=c&keep=1'
      expect(stripTrackingParameters(url)).toBe('https://example.com/x?keep=1')
    })

    it('strips Marketo mkt_tok', () => {
      const url = 'https://example.com/x?mkt_tok=abc'
      expect(stripTrackingParameters(url)).toBe('https://example.com/x')
    })

    it('strips Vero / Salesforce / Adobe campaign IDs', () => {
      const url = 'https://example.com/x?vero_id=a&vero_conv=b&sc_cid=c&s_cid=d&keep=1'
      expect(stripTrackingParameters(url)).toBe('https://example.com/x?keep=1')
    })
  })

  describe('stripTrackingParameters (negative cases)', () => {
    it('preserves URL with only non-tracking params', () => {
      const url = 'https://example.com/page?foo=bar&page=2'
      expect(stripTrackingParameters(url)).toBe(url)
    })

    it('preserves non-tracking params on a known domain', () => {
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

    it('does not strip params that merely contain a tracking substring', () => {
      // `mutmason` starts with `mutm`, not `utm_`. `gclidone` is not `gclid`.
      const url = 'https://example.com/x?mutmason=a&gclidone=b&keep=z'
      expect(stripTrackingParameters(url)).toBe(url)
    })
  })

  describe('stripUrlsInText', () => {
    beforeEach(() => {
      vi.stubGlobal('localStorage', {
        getItem: vi.fn().mockReturnValue('true'),
        setItem: vi.fn(),
      })
    })

    it('strips tracking params from URLs in text', () => {
      const text = 'Check this out: https://youtu.be/abc?si=xyz and more text'
      expect(stripUrlsInText(text)).toBe('Check this out: https://youtu.be/abc and more text')
    })

    it('strips utm from arbitrary URLs in text', () => {
      const text = 'Read: https://arstechnica.com/x?utm_brand=foo&utm_source=mastodon and watch https://x.com/u/status/1?s=20'
      const cleaned = stripUrlsInText(text)
      expect(cleaned).not.toContain('utm_')
      expect(cleaned).not.toContain('s=20')
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
