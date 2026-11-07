import { describe, it, expect, vi, beforeEach } from 'vitest'

// An invite link to a server on another Harmony instance previews as its server card
// (provider harmony-remote-invite); one the resolver does not take is read as a page, and a
// Harmony host that does not answer leaves no card.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', NODE_ENV: 'test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => ({}) }))
vi.mock('../services/KlipyService.js', () => ({ fetchKlipyMediaBySlug: vi.fn(async () => null) }))
vi.mock('../activitypub/SignatureService.js', () => ({
  SignatureService: { signedApFetch: vi.fn(async () => { throw new Error('not ActivityPub') }) },
}))
const safeFetch = vi.hoisted(() => vi.fn())
vi.mock('../utils/ssrfProtection.js', () => ({
  safeFetch,
  validateExternalUrl: (u: string) => new URL(u),
}))
const resolveRemoteInvite = vi.hoisted(() => vi.fn())
vi.mock('../services/remoteInvitePreview.js', () => ({ resolveRemoteInvite }))

const { linkPreviewService } = await import('../services/LinkPreviewService.js')

const CARD = {
  status: 'valid' as const,
  code: 'GOODCODE',
  domain: 'peer.test',
  instance: { name: 'Peer Harmony', icon: 'https://peer.test/icon.png' },
  server: {
    name: 'Timbre', description: 'Alternative Har.mony client', icon: 'https://peer.test/a.png',
    memberCount: 6, onlineCount: 2, id: 'https://peer.test/servers/0b0e0000-0000-4000-8000-0000000000a1',
  },
}

function page(html: string, url: string): Response {
  const res = new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  Object.defineProperty(res, 'url', { value: url })
  return res
}

let n = 0

beforeEach(() => {
  safeFetch.mockReset()
  resolveRemoteInvite.mockReset()
})

describe('remote invite previews', () => {
  it('previews a Harmony invite as its server card, reading no page', async () => {
    resolveRemoteInvite.mockResolvedValue({ status: 'card', card: CARD })
    const url = `https://peer${++n}.test/invite/GOODCODE`
    const preview = await linkPreviewService.getPreview(url)
    expect(preview).toMatchObject({
      provider: 'harmony-remote-invite',
      title: 'Timbre',
      description: 'Alternative Har.mony client',
      siteName: 'Peer Harmony',
      icon: 'https://peer.test/a.png',
      remoteInvite: CARD,
    })
    expect(preview.failed).toBeUndefined()
    expect(resolveRemoteInvite).toHaveBeenCalledWith(url)
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it('keeps a dead invite as a card naming no server', async () => {
    const dead = { status: 'invalid' as const, code: 'GONECODE', domain: 'peer.test', instance: CARD.instance }
    resolveRemoteInvite.mockResolvedValue({ status: 'card', card: dead })
    const preview = await linkPreviewService.getPreview(`https://peer${++n}.test/invite/GONECODE`)
    expect(preview.provider).toBe('harmony-remote-invite')
    expect(preview.remoteInvite).toEqual(dead)
    expect(preview.title).toBeUndefined()
  })

  it('leaves no card when a Harmony host does not answer', async () => {
    resolveRemoteInvite.mockResolvedValue({ status: 'unavailable' })
    const preview = await linkPreviewService.getPreview(`https://peer${++n}.test/invite/DOWNCODE`)
    expect(preview).toMatchObject({ provider: 'harmony-remote-invite', failed: true })
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it.each([
    ['the resolver takes none', async () => ({ status: 'none' })],
    ['the resolver fails', async () => { throw new Error('cache down') }],
  ])('reads the page when %s', async (_label, answer) => {
    resolveRemoteInvite.mockImplementation(answer)
    const url = `https://chat${++n}.example/invite/abc123`
    safeFetch.mockResolvedValue(page('<head><meta property="og:title" content="Join us"></head>', url))
    const preview = await linkPreviewService.getPreview(url)
    expect(preview.provider).toBe('generic')
    expect(preview.title).toBe('Join us')
    expect(preview.remoteInvite).toBeUndefined()
  })
})
