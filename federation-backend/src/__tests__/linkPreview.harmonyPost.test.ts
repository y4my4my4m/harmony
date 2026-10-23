import { describe, it, expect, vi, beforeEach } from 'vitest'

// A link to a post of this instance previews as the post itself: its id /posts/<id> and its
// public page /@<name>/<id> (publicPages/routes.ts) alike.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', NODE_ENV: 'test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../services/KlipyService.js', () => ({ fetchKlipyMediaBySlug: vi.fn(async () => null) }))
vi.mock('../activitypub/SignatureService.js', () => ({
  SignatureService: { signedApFetch: vi.fn(async () => { throw new Error('not ActivityPub') }) },
}))
const safeFetch = vi.hoisted(() => vi.fn(async () => { throw new Error('no fetch expected') }))
vi.mock('../utils/ssrfProtection.js', () => ({
  safeFetch,
  validateExternalUrl: (u: string) => new URL(u),
}))

const POST_ID = '0b0e0000-0000-4000-8000-0000000000a1'
const lookups: string[] = []
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: () => {
      let id = ''
      const q: any = {
        select: () => q,
        eq: (_col: string, value: string) => { id = value; lookups.push(value); return q },
        single: async () => (id.toLowerCase() === POST_ID
          ? {
              data: {
                id: POST_ID, content: [{ type: 'text', text: 'hello from the page' }], visibility: 'public',
                is_deleted: false, is_local: true,
                media_attachments: [{ type: 'Image', url: 'https://harmony.test/media/a.png', preview_url: 'https://harmony.test/media/a-small.png' }],
                author: { id: 'a1', username: 'alice', display_name: 'Alice', domain: 'harmony.test' },
              },
              error: null,
            }
          : { data: null, error: { message: 'not found' } }),
      }
      return q
    },
  }),
}))

const { linkPreviewService } = await import('../services/LinkPreviewService.js')

let n = 0

beforeEach(() => {
  lookups.length = 0
  safeFetch.mockClear()
})

describe('Harmony post previews', () => {
  it.each([
    `https://harmony.test/@alice/${POST_ID}`,
    `https://harmony.test/posts/${POST_ID}`,
  ])('%s previews as the post', async (url) => {
    const preview = await linkPreviewService.getPreview(`${url}?n=${++n}`)
    expect(preview.provider).toBe('harmony-post')
    expect(preview.harmony?.postId).toBe(POST_ID)
    expect(preview.description).toBe('hello from the page')
    // Posts written in the app type their media 'Image'.
    expect(preview.image).toBe('https://harmony.test/media/a-small.png')
    expect(lookups).toEqual([POST_ID])
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it('reads no post for a /@ page of another host', async () => {
    await linkPreviewService.getPreview(`https://elsewhere.test/@alice/${POST_ID}?n=${++n}`).catch(() => null)
    expect(lookups).toEqual([])
  })
})
