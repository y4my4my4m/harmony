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

import {
  getFullAvatarUrl,
  getFullBannerUrl,
  getFullServerIconUrl,
  isDefaultServerIcon,
} from '../utils/urlUtils.js'

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

  describe('isDefaultServerIcon', () => {
    it('treats null, empty, and DB default as default', () => {
      expect(isDefaultServerIcon(null)).toBe(true)
      expect(isDefaultServerIcon('')).toBe(true)
      expect(isDefaultServerIcon('/default_server.webp')).toBe(true)
    })

    it('detects mangled storage URLs for the default icon', () => {
      expect(isDefaultServerIcon(
        'https://supabase.example/storage/v1/render/image/public/server_icons//default_server.webp?width=96',
      )).toBe(true)
    })

    it('does not treat custom storage paths as default', () => {
      expect(isDefaultServerIcon('a1b2c3d4-e5f6-7890-abcd-ef1234567890/icon.webp')).toBe(false)
    })
  })

  describe('getFullServerIconUrl', () => {
    it('returns null for the default icon', () => {
      expect(getFullServerIconUrl('/default_server.webp')).toBeNull()
    })

    it('converts custom storage paths to public URLs', () => {
      const result = getFullServerIconUrl('server-id/custom.webp')
      expect(result).toContain('supabase.harmony.test')
      expect(result).toContain('server_icons')
    })
  })
})
