import { describe, it, expect, vi, beforeEach } from 'vitest'

// Copying a moved account's profile: who may, what is read from the old row, what a remote field
// value becomes, and that images are stored again rather than linked.

const config = vi.hoisted(() => ({
  INSTANCE_DOMAIN: 'harmony.test',
  SUPABASE_URL: 'http://kong:8000',
  PUBLIC_SUPABASE_URL: 'https://db.harmony.test',
}))
vi.mock('../config/index.js', () => ({ default: config, config }))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../routes/adminEmojis.js', () => ({
  sniffImage: (b: Uint8Array) => (b[0] === 0x89 ? { ext: 'png', contentType: 'image/png' } : null),
}))
vi.mock('../utils/stripMetadata.js', () => ({
  stripMediaBytes: async (b: Uint8Array) => b,
}))

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

const storage = vi.hoisted(() => ({
  downloads: [] as string[],
  uploads: [] as Array<{ bucket: string; path: string; opts: any }>,
  removed: [] as Array<{ bucket: string; paths: string[] }>,
  limit: 0,
  uploadError: null as any,
  object: null as any,
}))
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    storage: {
      getBucket: async () => ({ data: { file_size_limit: storage.limit } }),
      from: (bucket: string) => ({
        download: async (path: string) => {
          storage.downloads.push(`${bucket}/${path}`)
          return storage.object ? { data: storage.object, error: null } : { data: null, error: { message: 'gone' } }
        },
        upload: async (path: string, _bytes: any, opts: any) => {
          storage.uploads.push({ bucket, path, opts })
          return { error: storage.uploadError }
        },
        remove: async (paths: string[]) => {
          storage.removed.push({ bucket, paths })
          return { error: null }
        },
      }),
    },
  }),
}))

const fetched = vi.hoisted(() => ({ urls: [] as string[], response: null as any }))
vi.mock('../utils/ssrfProtection.js', () => ({
  safeFetch: vi.fn(async (url: string) => {
    fetched.urls.push(url)
    if (fetched.response instanceof Error) throw fetched.response
    return fetched.response
  }),
}))

import {
  buildProfileCopy,
  copiedFieldValue,
  copiedProfileFields,
  isVerifiedOrigin,
  parseCopyFields,
  removeCopiedImages,
  type CopyOrigin,
} from '../activitypub/profileCopy.js'

const origin = (over: Partial<CopyOrigin> = {}): CopyOrigin => ({
  id: 'old',
  username: 'old',
  domain: 'old.test',
  federated_id: 'https://old.test/users/old',
  moved_to_id: 'new',
  display_name: 'Old Name',
  bio: 'Old bio',
  avatar_url: 'https://old.test/a.png',
  banner_url: 'https://old.test/b.png',
  profile_fields: [{ name: 'Site', value: 'plain' }],
  ...over,
})

beforeEach(() => {
  storage.downloads = []
  storage.uploads = []
  storage.removed = []
  storage.limit = 0
  storage.uploadError = null
  storage.object = null
  fetched.urls = []
  fetched.response = { ok: true, status: 200, arrayBuffer: async () => PNG.buffer }
})

describe('isVerifiedOrigin', () => {
  it('needs both sides: the old account points here and this one lists it', () => {
    expect(isVerifiedOrigin(origin(), 'new', ['https://old.test/users/old'])).toBe(true)
    expect(isVerifiedOrigin(origin(), 'new', [])).toBe(false)
    expect(isVerifiedOrigin(origin(), 'new', null)).toBe(false)
    expect(isVerifiedOrigin(origin({ moved_to_id: 'other' }), 'new', ['https://old.test/users/old'])).toBe(false)
    expect(isVerifiedOrigin(origin({ moved_to_id: null }), 'new', ['https://old.test/users/old'])).toBe(false)
    expect(isVerifiedOrigin(null, 'new', ['https://old.test/users/old'])).toBe(false)
  })

  it('derives the actor URI of a local account stored without one', () => {
    const local = origin({ federated_id: null, domain: 'harmony.test', username: 'old' })
    expect(isVerifiedOrigin(local, 'new', ['https://harmony.test/users/old'])).toBe(true)
  })
})

describe('parseCopyFields', () => {
  it('keeps known fields once each', () => {
    expect(parseCopyFields(['bio', 'bio', 'is_admin', 'avatar'])).toEqual(['bio', 'avatar'])
    expect(parseCopyFields('bio')).toEqual([])
    expect(parseCopyFields(undefined)).toEqual([])
  })
})

describe('copiedFieldValue', () => {
  const anchor = (url: string) => `<a href="${url}" target="_blank" rel="me nofollow noopener noreferrer">${url}</a>`

  it('takes Mastodon\'s link markup down to the anchor the client writes', () => {
    const mastodon = '<a href="https://blog.example/me" target="_blank" rel="nofollow noopener me" translate="no">'
      + '<span class="invisible">https://</span><span class="">blog.example/me</span><span class="invisible"></span></a>'
    expect(copiedFieldValue(mastodon)).toBe(anchor('https://blog.example/me'))
  })

  it('keeps the URL of an anchor the 255-character clamp cut', () => {
    const cut = '<a href="https://blog.example/me" target="_blank" rel="nofollow noopener me" translate="no"><span class="invis'
    expect(copiedFieldValue(cut)).toBe(anchor('https://blog.example/me'))
  })

  it('stores plain text escaped', () => {
    expect(copiedFieldValue('Tom &amp; Jerry')).toBe('Tom &amp; Jerry')
    expect(copiedFieldValue('<b>bold</b> text')).toBe('bold text')
    expect(copiedFieldValue('a < b')).toBe('a &lt; b')
  })

  it('leaves no markup or script behind', () => {
    const value = copiedFieldValue('<script>alert(1)</script><img src=x onerror=alert(1)>')
    expect(value).not.toMatch(/<(script|img)/i)
    expect(copiedFieldValue('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(copiedFieldValue('<a href="javascript:alert(1)">x</a>')).toBe('x')
  })

  it('escapes an anchor\'s URL', () => {
    expect(copiedFieldValue('<a href="https://x.test/?a=1&amp;b=2">x</a>')).toBe(anchor('https://x.test/?a=1&amp;b=2'))
  })

  it('stores a long URL as text: the clamp would cut its anchor', () => {
    const url = `https://x.test/${'p'.repeat(120)}`
    expect(copiedFieldValue(`<a href="${url}">link</a>`)).toBe(url)
  })

  it('reduces nothing to nothing', () => {
    expect(copiedFieldValue(null)).toBe('')
    expect(copiedFieldValue('<br>')).toBe('')
  })
})

describe('copiedProfileFields', () => {
  it('drops rows without a name or a value, and holds four', () => {
    const rows = [
      { name: 'One', value: '1' }, { name: '', value: '2' }, { name: 'Three', value: '<br>' },
      { name: 'Four', value: '4' }, { name: 'Five', value: '5' }, { name: 'Six', value: '6' }, { name: 'Seven', value: '7' },
    ]
    expect(copiedProfileFields(rows).map((r) => r.name)).toEqual(['One', 'Four', 'Five', 'Six'])
  })

  it('reads a value that is not an array as none', () => {
    expect(copiedProfileFields(null)).toEqual([])
    expect(copiedProfileFields({})).toEqual([])
  })

  it('drops a key other than name and value: verified_at does not carry over', () => {
    expect(copiedProfileFields([{ name: 'A', value: 'b', verified_at: '2026-01-01' }])).toEqual([{ name: 'A', value: 'b' }])
  })
})

describe('buildProfileCopy', () => {
  it('copies only what is asked', async () => {
    const copy = await buildProfileCopy(origin(), ['display_name'], 'auth-id')
    expect(copy).toEqual({ update: { display_name: 'Old Name' }, copied: ['display_name'], failed: [] })
    expect(fetched.urls).toEqual([])
  })

  it('never blanks the new account: an empty old value is skipped', async () => {
    const copy = await buildProfileCopy(
      origin({ display_name: null, bio: '   ', avatar_url: null, banner_url: null, profile_fields: [] }),
      ['display_name', 'bio', 'avatar', 'banner', 'profile_fields'],
      'auth-id',
    )
    expect(copy).toEqual({ update: {}, copied: [], failed: [] })
  })

  it('takes the default avatar as none: there is nothing to copy', async () => {
    const copy = await buildProfileCopy(origin({ avatar_url: '/default_avatar.webp' }), ['avatar'], 'auth-id')
    expect(copy).toEqual({ update: {}, copied: [], failed: [] })
    expect(storage.downloads).toEqual([])
    expect(fetched.urls).toEqual([])
  })

  it('stores a remote image under the new account and names the object, never the old URL', async () => {
    const copy = await buildProfileCopy(origin(), ['avatar', 'banner'], 'auth-id')
    expect(fetched.urls).toEqual(['https://old.test/a.png', 'https://old.test/b.png'])
    expect(storage.uploads.map((u) => u.bucket)).toEqual(['avatars', 'banners'])
    expect(copy.update.avatar_url).toMatch(/^auth-id\/avatar-\d+-[0-9a-f]{8}\.png$/)
    expect(copy.update.banner_url).toMatch(/^auth-id\/banner-\d+-[0-9a-f]{8}\.png$/)
    expect(storage.uploads[0].opts).toMatchObject({ contentType: 'image/png', upsert: false })
    expect(JSON.stringify(copy.update)).not.toContain('old.test')
  })

  it.each([
    ['a path', 'folder/avatar-1.png'],
    ['the public URL', 'https://db.harmony.test/storage/v1/object/public/avatars/folder/avatar-1.png'],
    ['the internal URL', 'http://kong:8000/storage/v1/object/public/avatars/folder/avatar-1.png'],
  ])('reads a local avatar given as %s from storage, not over the network', async (_label, source) => {
    storage.object = { arrayBuffer: async () => PNG.buffer }
    const copy = await buildProfileCopy(origin({ avatar_url: source }), ['avatar'], 'auth-id')
    expect(storage.downloads).toEqual(['avatars/folder/avatar-1.png'])
    expect(fetched.urls).toEqual([])
    expect(copy.copied).toEqual(['avatar'])
  })

  it('does not read a path outside the bucket prefix from another host as local', async () => {
    const copy = await buildProfileCopy(
      origin({ avatar_url: 'https://evil.test/storage/v1/object/public/avatars/folder/avatar-1.png' }),
      ['avatar'],
      'auth-id',
    )
    expect(storage.downloads).toEqual([])
    expect(fetched.urls).toHaveLength(1)
    expect(copy.copied).toEqual(['avatar'])
  })

  it('reports an image it cannot read as failed, and copies the rest', async () => {
    fetched.response = { ok: false, status: 404, body: null, arrayBuffer: async () => new ArrayBuffer(0) }
    const copy = await buildProfileCopy(origin(), ['bio', 'avatar'], 'auth-id')
    expect(copy.update).toEqual({ bio: 'Old bio' })
    expect(copy.copied).toEqual(['bio'])
    expect(copy.failed).toEqual(['avatar'])
  })

  it('reports a fetch the SSRF guard refuses as failed', async () => {
    fetched.response = new Error('Blocked hostname')
    const copy = await buildProfileCopy(origin(), ['avatar'], 'auth-id')
    expect(copy.failed).toEqual(['avatar'])
  })

  it('refuses bytes that are no image, whatever the server calls them', async () => {
    fetched.response = { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('<html>').buffer }
    const copy = await buildProfileCopy(origin(), ['avatar'], 'auth-id')
    expect(copy.failed).toEqual(['avatar'])
    expect(storage.uploads).toEqual([])
  })

  it('refuses an image over the bucket\'s limit', async () => {
    storage.limit = 2
    const copy = await buildProfileCopy(origin(), ['avatar'], 'auth-id')
    expect(copy.failed).toEqual(['avatar'])
    expect(storage.uploads).toEqual([])
  })

  it('reports a failed store as failed', async () => {
    storage.uploadError = { message: 'quota' }
    const copy = await buildProfileCopy(origin(), ['avatar'], 'auth-id')
    expect(copy.failed).toEqual(['avatar'])
    expect(copy.update).toEqual({})
  })
})

describe('removeCopiedImages', () => {
  it('removes stored objects and ignores other columns', async () => {
    await removeCopiedImages({ avatar_url: 'a/1.png', banner_url: 'a/2.png', bio: 'x' })
    expect(storage.removed).toEqual([
      { bucket: 'avatars', paths: ['a/1.png'] },
      { bucket: 'banners', paths: ['a/2.png'] },
    ])
  })
})
