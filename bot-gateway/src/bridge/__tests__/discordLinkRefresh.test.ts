import { describe, it, expect, vi } from 'vitest'
import {
  DiscordLinkRefresher,
  REFRESH_URLS_MAX,
  expiredDiscordAttachmentUrls,
  refreshDiscordAttachmentUrls,
  withSignedUrls,
} from '../discordLinkRefresh.js'

const NOW = Date.UTC(2026, 10, 13, 15, 0, 0)
const hex = (ms: number) => Math.floor(ms / 1000).toString(16)
const signed = (path: string, expiresMs: number, host = 'cdn.discordapp.com') =>
  `https://${host}${path}?ex=${hex(expiresMs)}&is=${hex(expiresMs - 86_400_000)}&hm=${'a'.repeat(64)}&`

const CLIP = '/attachments/492163058312151061/1569015022057693324/clip.mp4'
const PHOTO = '/attachments/492163058312151061/1569015022057693325/photo.png'
const EXPIRED_CLIP = signed(CLIP, NOW - 3_600_000)
const FRESH_CLIP = signed(CLIP, NOW + 86_400_000)

function discordAnswer(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

describe('expiredDiscordAttachmentUrls', () => {
  it('takes expired, unsigned and nearly expired attachment links of file and url parts', () => {
    const nearlyExpired = signed(PHOTO, NOW + 30_000)
    const unsigned = `https://media.discordapp.net/attachments/1/2/old.gif`
    const content = [
      { type: 'text', text: EXPIRED_CLIP },
      { type: 'url', url: EXPIRED_CLIP },
      { type: 'file', url: nearlyExpired, fileName: 'photo.png' },
      { type: 'url', url: unsigned },
      { type: 'url', url: signed('/attachments/1/3/later.png', NOW + 3_600_000) },
    ]
    expect(expiredDiscordAttachmentUrls(content, NOW)).toEqual([EXPIRED_CLIP, nearlyExpired, unsigned])
  })

  it('leaves out emoji and avatar URLs, other hosts and plain http', () => {
    const content = [
      { type: 'url', url: 'https://cdn.discordapp.com/emojis/123.png' },
      { type: 'url', url: 'https://cdn.discordapp.com/avatars/1/abc.png' },
      { type: 'url', url: `https://cdn.discordapp.com.evil.example${CLIP}` },
      { type: 'url', url: `http://cdn.discordapp.com${CLIP}` },
      { type: 'url', url: 'not a url' },
    ]
    expect(expiredDiscordAttachmentUrls(content, NOW)).toEqual([])
    expect(expiredDiscordAttachmentUrls(null, NOW)).toEqual([])
  })

  it(`stops at ${REFRESH_URLS_MAX} links`, () => {
    const content = Array.from({ length: REFRESH_URLS_MAX + 5 }, (_, i) => ({ type: 'url', url: `https://cdn.discordapp.com/attachments/1/${i}/f.png` }))
    expect(expiredDiscordAttachmentUrls(content, NOW)).toHaveLength(REFRESH_URLS_MAX)
  })
})

describe('refreshDiscordAttachmentUrls', () => {
  it('posts the URLs with the bot token and maps each attachment to its new URL', async () => {
    const fetchImpl = discordAnswer(200, { refreshed_urls: [{ original: EXPIRED_CLIP, refreshed: FRESH_CLIP }] })
    const result = await refreshDiscordAttachmentUrls([EXPIRED_CLIP], 'tok.en.value', fetchImpl as unknown as typeof fetch)

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://discord.com/api/v10/attachments/refresh-urls')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bot tok.en.value')
    expect(JSON.parse(String(init?.body))).toEqual({ attachment_urls: [EXPIRED_CLIP] })
    expect(result).toEqual({ ok: true, signed: new Map([[`cdn.discordapp.com${CLIP}`, FRESH_CLIP]]) })
  })

  it('drops an answer for another path, another host, a URL not asked for, or one without ex', async () => {
    const fetchImpl = discordAnswer(200, { refreshed_urls: [
      { original: EXPIRED_CLIP, refreshed: signed(PHOTO, NOW + 86_400_000) },
      { original: EXPIRED_CLIP, refreshed: signed(CLIP, NOW + 86_400_000, 'media.discordapp.net') },
      { original: signed(PHOTO, NOW - 1), refreshed: signed(PHOTO, NOW + 86_400_000) },
      { original: EXPIRED_CLIP, refreshed: `https://cdn.discordapp.com${CLIP}` },
      { original: EXPIRED_CLIP, refreshed: 'javascript:alert(1)' },
    ] })
    const result = await refreshDiscordAttachmentUrls([EXPIRED_CLIP], 't', fetchImpl as unknown as typeof fetch)
    expect(result).toEqual({ ok: true, signed: new Map() })
  })

  it('reports a rate limit with its retry_after, and other refusals by status', async () => {
    expect(await refreshDiscordAttachmentUrls([EXPIRED_CLIP], 't', discordAnswer(429, { retry_after: 1.5 }) as unknown as typeof fetch))
      .toEqual({ ok: false, status: 429, retryAfterMs: 1500 })
    expect(await refreshDiscordAttachmentUrls([EXPIRED_CLIP], 't', discordAnswer(401, { message: '401: Unauthorized' }) as unknown as typeof fetch))
      .toEqual({ ok: false, status: 401 })
    const offline = vi.fn(async () => { throw new TypeError('fetch failed') })
    expect(await refreshDiscordAttachmentUrls([EXPIRED_CLIP], 't', offline as unknown as typeof fetch))
      .toEqual({ ok: false, status: 0 })
  })
})

describe('withSignedUrls', () => {
  it('swaps the URL of each signed part and keeps every other field', () => {
    const content = [
      { type: 'text', text: 'look' },
      { type: 'url', url: EXPIRED_CLIP, label: 'clip' },
      { type: 'file', url: signed(CLIP, NOW - 1), fileName: 'clip.mp4', fileType: 'video' },
    ]
    const map = new Map([[`cdn.discordapp.com${CLIP}`, FRESH_CLIP]])
    expect(withSignedUrls(content, map)).toEqual([
      { type: 'text', text: 'look' },
      { type: 'url', url: FRESH_CLIP, label: 'clip' },
      { type: 'file', url: FRESH_CLIP, fileName: 'clip.mp4', fileType: 'video' },
    ])
  })

  it('answers null when nothing changes', () => {
    expect(withSignedUrls([{ type: 'url', url: FRESH_CLIP }], new Map([[`cdn.discordapp.com${CLIP}`, FRESH_CLIP]]))).toBeNull()
    expect(withSignedUrls([{ type: 'url', url: EXPIRED_CLIP }], new Map())).toBeNull()
  })
})

describe('DiscordLinkRefresher', () => {
  function refresher(over: { fetchImpl?: ReturnType<typeof discordAnswer>; token?: string | null; write?: boolean } = {}) {
    let clock = NOW
    const fetchImpl = over.fetchImpl ?? vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const urls = JSON.parse(String(init?.body)).attachment_urls as string[]
      const refreshed_urls = urls.map((original) => ({ original, refreshed: `${original.split('?')[0]}?ex=${hex(NOW + 86_400_000)}&is=1&hm=2&` }))
      return new Response(JSON.stringify({ refreshed_urls }), { status: 200 })
    })
    const token = vi.fn(async () => (over.token === undefined ? 'tok.en.value' : over.token))
    const write = vi.fn(async (_id: string, _old: unknown, _content: unknown[]) => over.write ?? true)
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const r = new DiscordLinkRefresher({ token, write, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock, log })
    return { r, fetchImpl, token, write, advance: (ms: number) => { clock += ms } }
  }

  it('signs several messages in one Discord call and writes each against the content it read', async () => {
    const { r, fetchImpl, write } = refresher()
    const a = [{ type: 'url', url: EXPIRED_CLIP }]
    const b = [{ type: 'file', url: signed(PHOTO, NOW - 1) }]
    expect(await r.request('m-a', a, expiredDiscordAttachmentUrls(a, NOW))).toBe('queued')
    expect(await r.request('m-b', b, expiredDiscordAttachmentUrls(b, NOW))).toBe('queued')
    expect(await r.request('m-a', a, expiredDiscordAttachmentUrls(a, NOW))).toBe('queued')
    await r.drain()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).attachment_urls).toHaveLength(2)
    expect(write.mock.calls.map((c) => c[0])).toEqual(['m-a', 'm-b'])
    expect(write.mock.calls[0][1]).toBe(a)
    expect((write.mock.calls[0][2][0] as { url: string }).url).toMatch(new RegExp(`^https://cdn\\.discordapp\\.com${CLIP}\\?ex=${hex(NOW + 86_400_000)}&`))
  })

  it('does not queue again a message whose batch Discord is signing', async () => {
    let answer: (r: Response) => void = () => {}
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve }))
    const { r, write } = refresher({ fetchImpl: fetchImpl as unknown as ReturnType<typeof discordAnswer> })
    const a = [{ type: 'url', url: EXPIRED_CLIP }]
    expect(await r.request('m-a', a, expiredDiscordAttachmentUrls(a, NOW))).toBe('queued')
    const draining = r.drain()
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    expect(await r.request('m-a', a, expiredDiscordAttachmentUrls(a, NOW))).toBe('queued')
    answer(new Response(JSON.stringify({ refreshed_urls: [{ original: EXPIRED_CLIP, refreshed: `${EXPIRED_CLIP.split('?')[0]}?ex=${hex(NOW + 86_400_000)}&is=1&hm=2&` }] }), { status: 200 }))
    await draining
    await r.drain()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it(`splits a queue over ${REFRESH_URLS_MAX} links into several calls`, async () => {
    const { r, fetchImpl } = refresher()
    for (let m = 0; m < 3; m++) {
      const content = Array.from({ length: 20 }, (_, i) => ({ type: 'url', url: `https://cdn.discordapp.com/attachments/${m}/${i}/f.png` }))
      await r.request(`m-${m}`, content, expiredDiscordAttachmentUrls(content, NOW))
    }
    await r.drain()
    expect(fetchImpl.mock.calls.map((c) => JSON.parse(String(c[1]?.body)).attachment_urls.length)).toEqual([40, 20])
  })

  it('answers no_signer while the instance has no Discord application, and asks the database once a minute', async () => {
    const { r, token, fetchImpl, advance } = refresher({ token: null })
    const content = [{ type: 'url', url: EXPIRED_CLIP }]
    expect(await r.request('m', content, [EXPIRED_CLIP])).toBe('no_signer')
    expect(await r.request('m', content, [EXPIRED_CLIP])).toBe('no_signer')
    expect(token).toHaveBeenCalledTimes(1)
    advance(61_000)
    await r.request('m', content, [EXPIRED_CLIP])
    expect(token).toHaveBeenCalledTimes(2)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('holds a message whose write the database refused, as one Discord did not sign', async () => {
    const { r, fetchImpl, write, advance } = refresher()
    write.mockRejectedValueOnce(new Error('BRIDGE_AUTHOR_OPTED_OUT'))
    const content = [{ type: 'url', url: EXPIRED_CLIP }]
    await r.request('m', content, [EXPIRED_CLIP])
    await r.drain()
    expect(write).toHaveBeenCalledTimes(1)
    expect(await r.request('m', content, [EXPIRED_CLIP])).toBe('failed_recently')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    advance(10 * 60_000 + 1)
    expect(await r.request('m', content, [EXPIRED_CLIP])).toBe('queued')
  })

  it('holds a message Discord did not re-sign for ten minutes', async () => {
    const { r, write, advance } = refresher({ fetchImpl: discordAnswer(200, { refreshed_urls: [] }) })
    const content = [{ type: 'url', url: EXPIRED_CLIP }]
    await r.request('m', content, [EXPIRED_CLIP])
    await r.drain()
    expect(write).not.toHaveBeenCalled()
    expect(await r.request('m', content, [EXPIRED_CLIP])).toBe('failed_recently')
    advance(10 * 60_000 + 1)
    expect(await r.request('m', content, [EXPIRED_CLIP])).toBe('queued')
  })

  it('pauses for retry_after when Discord rate-limits, without holding the messages', async () => {
    const { r, advance } = refresher({ fetchImpl: discordAnswer(429, { retry_after: 2 }) })
    const content = [{ type: 'url', url: EXPIRED_CLIP }]
    await r.request('m', content, [EXPIRED_CLIP])
    await r.drain()
    expect(await r.request('m', content, [EXPIRED_CLIP])).toBe('busy')
    advance(2_001)
    expect(await r.request('m', content, [EXPIRED_CLIP])).toBe('queued')
  })

  it('stops at 60 Discord calls a minute', async () => {
    const { r, fetchImpl, advance } = refresher()
    for (let m = 0; m < 60; m++) {
      const content = [{ type: 'url', url: `https://cdn.discordapp.com/attachments/1/${m}/f.png` }]
      await r.request(`m-${m}`, content, expiredDiscordAttachmentUrls(content, NOW))
      await r.drain()
    }
    expect(fetchImpl).toHaveBeenCalledTimes(60)
    expect(await r.request('m-60', [{ type: 'url', url: EXPIRED_CLIP }], [EXPIRED_CLIP])).toBe('busy')
    advance(60_001)
    expect(await r.request('m-60', [{ type: 'url', url: EXPIRED_CLIP }], [EXPIRED_CLIP])).toBe('queued')
  })

  it('admits 30 messages of one author a minute, and others\' messages meanwhile', async () => {
    const { r, advance } = refresher()
    const ask = (id: string, author: string) => {
      const content = [{ type: 'url', url: `https://cdn.discordapp.com/attachments/1/${id}/f.png` }]
      return r.request(id, content, expiredDiscordAttachmentUrls(content, NOW), author)
    }
    for (let m = 0; m < 30; m++) expect(await ask(`${m}`, 'user:spam')).toBe('queued')
    expect(await ask('30', 'user:spam')).toBe('busy')
    // A message already queued answers queued without counting again.
    expect(await ask('0', 'user:spam')).toBe('queued')
    expect(await ask('31', 'user:other')).toBe('queued')
    await r.drain()
    advance(60_001)
    expect(await ask('30', 'user:spam')).toBe('queued')
  })
})
