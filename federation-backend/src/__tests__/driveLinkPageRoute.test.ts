import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// GET /d/:token, the link-preview page of a Drive file's address. public.drive_link_resolve is
// emulated; its SQL is covered by db_schema/tests/144_drive_api.sql, 175_drive_file_links.sql and
// 179_drive_link_access.sql.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', INSTANCE_NAME: 'Harmony' },
  config: { INSTANCE_DOMAIN: 'harmony.test', INSTANCE_NAME: 'Harmony' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => (req: any, res: any, next: any) => fn(req, res, next).catch(next),
}))
vi.mock('../middleware/rateLimit.js', () => ({
  driveLinkPageLimiter: (_req: any, _res: any, next: any) => next(),
}))

const TOKEN = 'h5KAj-hPSm5hwCpMfeKM8aZl'
const IMAGE = {
  name: 'beach <trip>.png', mime_type: 'image/png', kind: 'image', size_bytes: 4096,
  created_at: '2026-10-20T00:00:00Z', expires_at: null,
  owner: null,
}
// drive_link_resolve with the link's Show my name on.
const SHOWN_OWNER = {
  id: '11111111-0000-0000-0000-000000000001', username: 'alice', display_name: 'Alice Secret :wave:',
  avatar_url: null, domain: null, emojis: [{ name: 'wave', url: 'https://cdn.test/wave.png' }],
}

const answers: Record<string, { data: unknown; error: unknown } | Error> = {}
const rpc = vi.fn(async (name: string, args: { p_token: string }) => {
  if (name !== 'drive_link_resolve') return { data: null, error: { message: `unexpected ${name}` } }
  const answer = answers[args.p_token] ?? { data: null, error: null }
  if (answer instanceof Error) throw answer
  return answer
})

// instance_config.instance_name as PostgREST answers it; undefined is no row, an Error a failed read.
const stored = vi.hoisted(() => ({ name: 'Example Chat' as unknown }))
function instanceConfig(table: string) {
  if (table !== 'instance_config') throw new Error(`unexpected table ${table}`)
  const read = async () => stored.name instanceof Error
    ? { data: null, error: { message: stored.name.message } }
    : { data: stored.name === undefined ? null : { config_value: stored.name }, error: null }
  const chain: any = { select: () => chain, eq: () => chain, maybeSingle: read }
  return chain
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({ rpc: (n: string, a: any) => rpc(n, a), from: instanceConfig }),
}))

const { default: driveLinkPageRouter } = await import('../routes/driveLinkPage.js')
const { clearInstanceNameCache } = await import('../utils/instanceName.js')

function app() {
  const a = express()
  a.use('/', driveLinkPageRouter)
  return a
}
const get = (path: string) =>
  supertest(app()).get(path).set('User-Agent', 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)')

beforeEach(() => {
  clearInstanceNameCache()
  stored.name = 'Example Chat'
  rpc.mockClear()
  for (const key of Object.keys(answers)) delete answers[key]
  answers[TOKEN] = { data: IMAGE, error: null }
})

describe('GET /d/:token', () => {
  it('serves the name, the type and a thumbnail of a live image link', async () => {
    const res = await get(`/d/${TOKEN}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers.vary).toMatch(/User-Agent/)
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow')
    expect(res.headers['content-security-policy']).toMatch(/^default-src 'none';/)
    expect(res.text).toContain('<meta property="og:title" content="beach &lt;trip&gt;.png">')
    expect(res.text).toContain('<meta property="og:description" content="Image · image/png">')
    expect(res.text).toContain(`<meta property="og:image" content="https://harmony.test/api/federation/drive/link/${TOKEN}?thumb=1">`)
    expect(res.text).toContain('<meta name="twitter:card" content="summary_large_image">')
    expect(res.text).toContain(`<meta property="og:url" content="https://harmony.test/d/${TOKEN}">`)
    expect(res.text).not.toMatch(/<script\b/i)
    expect(rpc.mock.calls).toEqual([['drive_link_resolve', { p_token: TOKEN }]])
  })

  it('names the instance as the admin panel stores it', async () => {
    const res = await get(`/d/${TOKEN}`)
    expect(res.text).toContain('<title>beach &lt;trip&gt;.png - Example Chat</title>')
    expect(res.text).toContain('<meta property="og:site_name" content="Example Chat">')
    expect(res.text).toContain('>Open in Example Chat</a>')
    expect(res.text).not.toContain('Harmony')

    answers[TOKEN] = { data: null, error: { message: 'connection refused' } }
    const down = await get(`/d/${TOKEN}`)
    expect(down.text).toContain('<title>Example Chat</title>')
    expect(down.text).toContain('Open it in Example Chat to see the file.')

    clearInstanceNameCache()
    stored.name = undefined
    expect((await get(`/d/${TOKEN}`)).text).toContain('<title>Harmony</title>')
  })

  it('names no owner, even with Show my name on, and no size', async () => {
    answers[TOKEN] = { data: { ...IMAGE, owner: SHOWN_OWNER }, error: null }
    const res = await get(`/d/${TOKEN}`)
    expect(res.status).toBe(200)
    expect(res.text).not.toContain('Alice Secret')
    expect(res.text).not.toContain('alice')
    expect(res.text).not.toContain('wave')
    expect(res.text).not.toContain('4096')
    expect(res.text).not.toContain('4 KB')
  })

  it('draws the instance icon for a file that is not a raster image', async () => {
    answers[TOKEN] = { data: { ...IMAGE, name: 'diagram.svg', mime_type: 'image/svg+xml' }, error: null }
    const svg = await get(`/d/${TOKEN}`)
    expect(svg.text).toContain('<meta property="og:image" content="https://harmony.test/img/app_icon_square.png">')
    expect(svg.text).not.toContain('thumb=1')

    answers[TOKEN] = { data: { ...IMAGE, name: 'notes.pdf', mime_type: 'application/pdf', kind: 'document' }, error: null }
    const pdf = await get(`/d/${TOKEN}`)
    expect(pdf.text).toContain('<meta property="og:description" content="Document · application/pdf">')
    expect(pdf.text).toContain('<meta name="twitter:card" content="summary">')
    expect(pdf.text).not.toContain('thumb=1')
  })

  it('answers a restricted, expired, reset or unknown token with no OpenGraph tags', async () => {
    delete answers[TOKEN]
    const res = await get(`/d/${TOKEN}`)
    expect(res.status).toBe(404)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.text).not.toContain('og:')
    expect(res.text).not.toContain('twitter:')
    expect(res.text).not.toContain('beach')
  })

  it.each(['short', 'a.b.c.d.e.f.g.h.i.j', 'x'.repeat(65), 'AB%2FCDEFGHIJKLMNOPQ'])('does not look up the malformed token %s', async (token) => {
    const res = await get(`/d/${token}`)
    expect(res.status).toBe(404)
    expect(res.text).not.toContain('og:')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('answers 503 without caching when the lookup fails', async () => {
    answers[TOKEN] = { data: null, error: { message: 'connection refused' } }
    const res = await get(`/d/${TOKEN}`)
    expect(res.status).toBe(503)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['retry-after']).toBe('30')
    expect(res.text).not.toContain('og:')
  })
})
