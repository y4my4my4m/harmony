import { describe, it, expect, vi } from 'vitest'

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    SUPABASE_URL: 'http://localhost:54321',
    PUBLIC_SUPABASE_URL: 'https://supabase.harmony.test',
  },
}))

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: vi.fn(() => ({
    storage: {
      from: vi.fn((bucket: string) => ({
        getPublicUrl: vi.fn((path: string) => ({
          data: { publicUrl: `http://localhost:54321/storage/v1/object/public/${bucket}/${path}` },
        })),
      })),
    },
  })),
}))

import { getFullAvatarUrl, getFullBannerUrl } from '../utils/urlUtils.js'

describe('urlUtils', () => {
  describe('getFullAvatarUrl', () => {
    it('returns null for null input', () => {
      expect(getFullAvatarUrl(null)).toBeNull()
    })

    it('returns null for undefined input', () => {
      expect(getFullAvatarUrl(undefined)).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(getFullAvatarUrl('')).toBeNull()
    })

    it('returns absolute URL as-is', () => {
      const url = 'https://remote.host/avatar.jpg'
      expect(getFullAvatarUrl(url)).toBe(url)
    })

    it('returns http URL as-is', () => {
      const url = 'http://remote.host/avatar.jpg'
      expect(getFullAvatarUrl(url)).toBe(url)
    })

    it('converts relative path to Supabase URL', () => {
      const result = getFullAvatarUrl('user-123/avatar.webp')
      expect(result).toContain('supabase.harmony.test')
      expect(result).toContain('avatars')
    })

    it('converts local asset path to absolute URL', () => {
      const result = getFullAvatarUrl('/assets/default.png')
      expect(result).toBe('https://harmony.test/assets/default.png')
    })
  })

  describe('getFullBannerUrl', () => {
    it('returns null for null input', () => {
      expect(getFullBannerUrl(null)).toBeNull()
    })

    it('returns absolute URL as-is', () => {
      const url = 'https://remote.host/banner.jpg'
      expect(getFullBannerUrl(url)).toBe(url)
    })

    it('converts relative path to Supabase URL with banners bucket', () => {
      const result = getFullBannerUrl('user-123/banner.webp')
      expect(result).toContain('supabase.harmony.test')
      expect(result).toContain('banners')
    })
  })
})
