import { beforeEach, describe, expect, it, vi } from 'vitest'

const uploads = vi.hoisted(() => [] as Array<{ bucket: string; path: string; bytes: Buffer; options: Record<string, unknown> }>)
vi.mock('../../config/supabase.js', () => ({
  supabase: {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, bytes: Buffer, options: Record<string, unknown>) => {
          uploads.push({ bucket, path, bytes, options })
          return { error: null }
        },
        remove: async () => ({ error: null }),
      }),
    },
  },
}))

import {
  ProfileImageError,
  discordGuildImageCdnUrl,
  ownProfileObjectPath,
  storeDiscordProfileImage,
} from '../discordProfileImage.js'

const SID = '11111111-2222-3333-4444-555555555555'
const HASH = '0'.repeat(32)

function chunk(type: string, data: number[]): number[] {
  const len = data.length
  return [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255,
    ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0]
}
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
function png(width: number, height: number): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...be32(width), ...be32(height), 8, 6, 0, 0, 0]), ...chunk('IEND', [])])
}
const ok = (body: Uint8Array, headers: Record<string, string> = {}) =>
  vi.fn(async () => new Response(body, { status: 200, headers })) as unknown as typeof fetch

beforeEach(() => {
  uploads.length = 0
})

describe('discordGuildImageCdnUrl', () => {
  it('cdn url uses png for a static hash and gif for a_', () => {
    expect(discordGuildImageCdnUrl('icon', '1', 'a_' + HASH)).toBe(`https://cdn.discordapp.com/icons/1/a_${HASH}.gif?size=1024`)
    expect(discordGuildImageCdnUrl('icon', '1', HASH)).toBe(`https://cdn.discordapp.com/icons/1/${HASH}.png?size=1024`)
    expect(discordGuildImageCdnUrl('banner', '1', HASH)).toBe(`https://cdn.discordapp.com/banners/1/${HASH}.png?size=2048`)
  })
})

describe('storeDiscordProfileImage', () => {
  it('stores a png under <serverId>/icon-<ts>.png', async () => {
    const r = await storeDiscordProfileImage('icon', SID, '1', HASH, ok(png(64, 64)))
    expect(r.path).toMatch(new RegExp(`^${SID}/icon-\\d+\\.png$`))
    expect(uploads).toHaveLength(1)
    expect(uploads[0].bucket).toBe('server_icons')
    expect(uploads[0].path).toBe(r.path)
    expect(uploads[0].options).toMatchObject({ contentType: 'image/png', upsert: false, cacheControl: '31536000' })
  })

  it('stores a banner in server_banners', async () => {
    const r = await storeDiscordProfileImage('banner', SID, '1', HASH, ok(png(64, 64)))
    expect(r.path).toMatch(new RegExp(`^${SID}/banner-\\d+\\.png$`))
    expect(uploads[0].bucket).toBe('server_banners')
  })

  it('refuses an icon over 5 MB as size', async () => {
    const f = ok(png(8, 8), { 'content-length': '5242881' })
    await expect(storeDiscordProfileImage('icon', SID, '1', HASH, f)).rejects.toMatchObject({ name: 'ProfileImageError', reason: 'size' })
    expect(uploads).toHaveLength(0)
  })

  it('refuses a banner over 10 MB as size', async () => {
    const f = ok(png(8, 8), { 'content-length': '10485761' })
    await expect(storeDiscordProfileImage('banner', SID, '1', HASH, f)).rejects.toBeInstanceOf(ProfileImageError)
    await expect(storeDiscordProfileImage('banner', SID, '1', HASH, f)).rejects.toMatchObject({ reason: 'size' })
  })

  it('refuses bytes that are not an image as type', async () => {
    const f = ok(new TextEncoder().encode('not an image at all'))
    await expect(storeDiscordProfileImage('icon', SID, '1', HASH, f)).rejects.toMatchObject({ reason: 'type' })
  })

  it('throws a plain Error on a CDN 404', async () => {
    const f = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch
    const err = await storeDiscordProfileImage('icon', SID, '1', HASH, f).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(ProfileImageError)
  })
})

describe('ownProfileObjectPath', () => {
  it('ignores foreign values', () => {
    for (const v of [null, 'https://example.com/x.png', 'other-server/icon-1.png', '/assets/default-icon.png', 'default.png']) {
      expect(ownProfileObjectPath('icon', SID, v)).toBeNull()
    }
    expect(ownProfileObjectPath('icon', SID, `${SID}/../x/icon-1.png`)).toBeNull()
  })
  it('accepts a bare path and a public URL', () => {
    expect(ownProfileObjectPath('icon', SID, `${SID}/icon-1.png`)).toBe(`${SID}/icon-1.png`)
    expect(ownProfileObjectPath('icon', SID, `https://x.test/storage/v1/object/public/server_icons/${SID}/icon-1.png`)).toBe(`${SID}/icon-1.png`)
    expect(ownProfileObjectPath('banner', SID, `https://x.test/storage/v1/object/public/server_icons/${SID}/icon-1.png`)).toBeNull()
  })
})
