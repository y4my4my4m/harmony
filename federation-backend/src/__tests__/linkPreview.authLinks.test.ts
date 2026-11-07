import { describe, it, expect, vi, beforeEach } from 'vitest'

// A GET of GoTrue's /auth/v1/verify spends the token in the link: the previewer fetches no
// sign-in service link, so an invitation pasted into a chat still works for the person.

vi.mock('../config/index.js', () => {
  const cfg = {
    INSTANCE_DOMAIN: 'harmony.test',
    NODE_ENV: 'test',
    SUPABASE_URL: 'http://kong:8000',
    PUBLIC_SUPABASE_URL: 'https://db.harmony.test',
  }
  return { default: cfg, config: cfg }
})
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../services/KlipyService.js', () => ({ fetchKlipyMediaBySlug: vi.fn(async () => null) }))
vi.mock('../activitypub/SignatureService.js', () => ({
  SignatureService: { signedApFetch: vi.fn(async () => { throw new Error('not ActivityPub') }) },
}))
const safeFetch = vi.hoisted(() => vi.fn(async () => new Response('<html><head><title>Page</title></head></html>', {
  status: 200,
  headers: { 'content-type': 'text/html' },
})))
vi.mock('../utils/ssrfProtection.js', () => ({
  safeFetch,
  validateExternalUrl: (u: string) => new URL(u),
}))
vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => ({}) }))

const { linkPreviewService, isAuthServiceLink } = await import('../services/LinkPreviewService.js')

beforeEach(() => {
  safeFetch.mockClear()
})

describe('sign-in service links', () => {
  it.each([
    'https://db.harmony.test/auth/v1/verify?token=abc&type=invite&redirect_to=https://harmony.test/reset-password?invite=1',
    'https://DB.harmony.test/rest/v1/profiles',
    'http://kong:8000/auth/v1/verify?token=abc&type=recovery',
    'https://project.supabase.co/auth/v1/verify?token=abc&type=signup',
    'https://other.example/auth/v1/verify?token=abc&type=magiclink',
    'db.harmony.test/auth/v1/verify?token=abc',
  ])('fetches nothing for %s', async (url) => {
    expect(isAuthServiceLink(url)).toBe(true)
    const preview = await linkPreviewService.getPreview(url)
    expect(preview.failed).toBe(true)
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it.each([
    'https://harmony.test/reset-password?invite=1&token_hash=abc&type=invite',
    'https://example.org/article',
    'https://example.org/docs/auth/v10/setup',
  ])('previews %s as before', (url) => {
    expect(isAuthServiceLink(url)).toBe(false)
  })

  it('reads an ordinary page', async () => {
    const preview = await linkPreviewService.getPreview('https://example.org/article')
    expect(safeFetch).toHaveBeenCalled()
    expect(preview.failed).toBeFalsy()
  })
})
