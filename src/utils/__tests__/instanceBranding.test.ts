import { describe, expect, it } from 'vitest'
import {
  BRANDING_TTL_MS,
  HARMONY_APP_ICON,
  brandingDue,
  instanceBannerStyle,
  instanceIconUrl,
} from '@/utils/instanceBranding'

const icon = 'https://db.mony.test/storage/v1/object/public/server_icons/instance/icon.webp'

describe('instance icon', () => {
  it('is the instance\'s own icon when it published one', () => {
    expect(instanceIconUrl({ software: 'harmony', metadata: { icon_url: icon } })).toBe(icon)
    expect(instanceIconUrl({ software: 'mastodon', metadata: { icon_url: icon } })).toBe(icon)
  })

  it('falls back to Harmony\'s icon for a Harmony peer, and to none for other software', () => {
    expect(instanceIconUrl({ software: 'Harmony', metadata: {} })).toBe(HARMONY_APP_ICON)
    expect(instanceIconUrl({ software: 'mastodon', metadata: {} })).toBeNull()
    expect(instanceIconUrl({ software: null, metadata: null })).toBeNull()
  })

  it('gives way to the fallback once the icon fails to load', () => {
    expect(instanceIconUrl({ software: 'harmony', metadata: { icon_url: icon } }, new Set([icon]))).toBe(HARMONY_APP_ICON)
    expect(instanceIconUrl({ software: 'pleroma', metadata: { icon_url: icon } }, new Set([icon]))).toBeNull()
  })

  it('takes http(s) URLs only', () => {
    expect(instanceIconUrl({ software: 'pleroma', metadata: { icon_url: 'javascript:alert(1)' } })).toBeNull()
    expect(instanceIconUrl({ software: 'pleroma', metadata: { icon_url: '/relative.png' } })).toBeNull()
  })
})

describe('instance banner', () => {
  it('is the banner image', () => {
    expect(instanceBannerStyle({ metadata: { banner_url: 'https://mony.test/b.png', theme_color: '#e67e22' } }))
      .toEqual({ backgroundImage: 'url("https://mony.test/b.png")' })
  })

  it('escapes quotes in the URL', () => {
    expect(instanceBannerStyle({ metadata: { banner_url: 'https://mony.test/a"b.png' } }))
      .toEqual({ backgroundImage: 'url("https://mony.test/a\\"b.png")' })
  })

  it('is a band in the theme colour without an image, and nothing without either', () => {
    expect(instanceBannerStyle({ metadata: { theme_color: '#e67e22' } })?.background).toContain('#e67e22')
    expect(instanceBannerStyle({ metadata: { theme_color: 'red; background: url(x)' } })).toBeNull()
    expect(instanceBannerStyle({ metadata: {} })).toBeNull()
  })
})

describe('branding refresh', () => {
  const now = Date.parse('2026-10-27T12:00:00Z')

  it('is due when never read or read more than a day ago', () => {
    expect(brandingDue({ metadata: {} }, now)).toBe(true)
    expect(brandingDue({ metadata: { branding_read_at: new Date(now - BRANDING_TTL_MS - 1).toISOString() } }, now)).toBe(true)
  })

  it('is not due within a day of the last read', () => {
    expect(brandingDue({ metadata: { branding_read_at: new Date(now - 3600_000).toISOString() } }, now)).toBe(false)
  })
})
