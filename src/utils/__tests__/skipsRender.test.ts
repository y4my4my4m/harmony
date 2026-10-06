import { describe, expect, it, vi } from 'vitest'

vi.mock('@/supabase', async () => {
  const { StorageClient } = await import('@supabase/storage-js')
  return { supabase: { storage: new StorageClient('http://localhost:54321/storage/v1') } }
})

import { getAttachmentThumbnailUrl, publicImageUrl, skipsRender } from '@/utils/storageImageUtils'
import { getAvatarUrl } from '@/utils/avatarUtils'
import { getPublicBannerUrl } from '@/utils/bannerUtils'
import { getEmojiUrl } from '@/utils/emojiUtils'
import { getGroupIconUrl } from '@/utils/groupIconUtils'
import { getServerBannerUrl, getServerIconUrl } from '@/utils/serverUtils'

const STORAGE = 'http://localhost:54321/storage/v1'
const object = (bucket: string, path: string) => `${STORAGE}/object/public/${bucket}/${path}`
const isRender = (url: string, bucket: string, path: string) =>
  url.startsWith(`${STORAGE}/render/image/public/${bucket}/${path}?`)

describe('skipsRender', () => {
  it('holds for APNG names, in any case, behind a query or fragment', () => {
    expect(skipsRender('u1/avatar-1.apng')).toBe(true)
    expect(skipsRender('u1/AVATAR.APNG')).toBe(true)
    expect(skipsRender(`${object('emojis', 's/u/e.apng')}?v=2`)).toBe(true)
    expect(skipsRender(`${object('emojis', 's/u/e.apng')}#x`)).toBe(true)
  })

  it('does not hold for GIF, WebP or static formats', () => {
    for (const path of ['u1/a.gif', 'u1/A.GIF', 'u1/a.png', 'u1/a.jpg', 'u1/a.webp', 'u1/moon.gif.thumbnail.webp', 'u1/apng', 'u1/a.apng.webp']) {
      expect(skipsRender(path)).toBe(false)
    }
    expect(skipsRender(null)).toBe(false)
    expect(skipsRender('')).toBe(false)
  })

  it('holds for an APNG content type whatever the name, and only for APNG', () => {
    expect(skipsRender('u1/a.png', 'image/apng')).toBe(true)
    expect(skipsRender('u1/a.bin', 'IMAGE/APNG')).toBe(true)
    expect(skipsRender(null, 'image/apng')).toBe(true)
    expect(skipsRender('u1/a.png', 'image/png')).toBe(false)
    expect(skipsRender('u1/a.gif', 'image/gif')).toBe(false)
  })
})

describe('publicImageUrl', () => {
  const transform = { width: 64, height: 64, resize: 'contain' as const, quality: 80 }

  it('returns the object URL for APNG', () => {
    expect(publicImageUrl('avatars', 'u1/a.apng', transform)).toBe(object('avatars', 'u1/a.apng'))
  })

  it('returns a render URL carrying the transform otherwise, GIF included', () => {
    for (const path of ['u1/a.webp', 'u1/a.gif']) {
      const url = publicImageUrl('avatars', path, transform)
      expect(isRender(url, 'avatars', path)).toBe(true)
      expect(new URL(url).searchParams.get('width')).toBe('64')
      expect(new URL(url).searchParams.get('resize')).toBe('contain')
    }
  })
})

describe('display URL builders', () => {
  it('avatars: paths and local URLs of APNG load the object; GIF renders', () => {
    expect(getAvatarUrl('u1/avatar-1.apng', 40)).toBe(object('avatars', 'u1/avatar-1.apng'))
    expect(getAvatarUrl(object('avatars', 'u1/avatar-1.apng'), 40)).toBe(object('avatars', 'u1/avatar-1.apng'))
    expect(isRender(getAvatarUrl('u1/avatar-1.gif', 40), 'avatars', 'u1/avatar-1.gif')).toBe(true)
    expect(isRender(getAvatarUrl('u1/avatar-1.png', 40), 'avatars', 'u1/avatar-1.png')).toBe(true)
  })

  it('profile banners', () => {
    expect(getPublicBannerUrl('u1/banner-1.apng')).toBe(object('banners', 'u1/banner-1.apng'))
    expect(isRender(getPublicBannerUrl('u1/banner-1.gif')!, 'banners', 'u1/banner-1.gif')).toBe(true)
    expect(isRender(getPublicBannerUrl('u1/banner-1.webp')!, 'banners', 'u1/banner-1.webp')).toBe(true)
  })

  it('server icons and banners', () => {
    expect(getServerIconUrl('s1/icon-1.apng')).toBe(object('server_icons', 's1/icon-1.apng'))
    expect(getServerIconUrl(object('server_icons', 's1/icon-1.apng'))).toBe(object('server_icons', 's1/icon-1.apng'))
    expect(isRender(getServerIconUrl('s1/icon-1.gif'), 'server_icons', 's1/icon-1.gif')).toBe(true)
    expect(isRender(getServerIconUrl('s1/icon-1.jpg'), 'server_icons', 's1/icon-1.jpg')).toBe(true)
    expect(getServerBannerUrl('s1/banner-1.apng')).toBe(object('server_banners', 's1/banner-1.apng'))
    expect(isRender(getServerBannerUrl('s1/banner-1.gif')!, 'server_banners', 's1/banner-1.gif')).toBe(true)
  })

  it('group icons', () => {
    expect(getGroupIconUrl('c1', 'c1/icon-1.apng')).toBe(object('group-icons', 'c1/icon-1.apng'))
    expect(isRender(getGroupIconUrl('c1', 'c1/icon-1.gif'), 'group-icons', 'c1/icon-1.gif')).toBe(true)
  })

  it('emojis: stored URLs and legacy paths', () => {
    expect(getEmojiUrl(object('emojis', 's1/u1/e.apng'))).toBe(object('emojis', 's1/u1/e.apng'))
    expect(getEmojiUrl('s1/u1/e.apng')).toBe(object('emojis', 's1/u1/e.apng'))
    expect(isRender(getEmojiUrl(object('emojis', 's1/u1/e.gif')), 'emojis', 's1/u1/e.gif')).toBe(true)
    expect(isRender(getEmojiUrl('s1/u1/e.gif'), 'emojis', 's1/u1/e.gif')).toBe(true)
    expect(isRender(getEmojiUrl(object('emojis', 's1/u1/e.webp')), 'emojis', 's1/u1/e.webp')).toBe(true)
  })

  it('attachment thumbnails: a PNG whose content type is APNG stays untransformed', () => {
    const png = object('user_media', 'u1/posts/a.png')
    expect(getAttachmentThumbnailUrl(png, 1024, 'image/apng')).toBe(png)
    expect(isRender(getAttachmentThumbnailUrl(png, 1024, 'image/png'), 'user_media', 'u1/posts/a.png')).toBe(true)
  })
})
