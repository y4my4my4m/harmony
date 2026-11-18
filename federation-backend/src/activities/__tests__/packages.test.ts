import { describe, expect, it, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { strToU8, zipSync } from 'fflate'
import { PackageError, parsePackage, sha256Hex } from '../packages.js'

const SVG = strToU8('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>')
const JS = strToU8('(function(){parent.postMessage({hp:1,t:"ready",sdk:"1.0.0"},"*")})()')

function manifest(over: Record<string, unknown> = {}) {
  return {
    id: 'tictac', name: 'Tic Tac', version: '1.2.3', description: 'Noughts and crosses',
    minPlayers: 2, maxPlayers: 2, contexts: ['direct', 'channel'], icon: 'icon.svg', accent: '#112233',
    entry: 'app.js', i18n: { ja: { name: '三目並べ' } }, ...over,
  }
}

function zip(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files)
}

const good = () => zip({ 'manifest.json': strToU8(JSON.stringify(manifest())), 'app.js': JS, 'icon.svg': SVG })

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return error instanceof PackageError ? error.code : `other: ${(error as Error).message}`
  }
  return 'no error'
}

describe('parsePackage', () => {
  it('reads a package and hashes its files', () => {
    const bytes = good()
    const pkg = parsePackage(bytes)
    expect(pkg.manifest).toMatchObject({ id: 'tictac', version: '1.2.3', contexts: ['direct', 'channel'], i18n: { ja: { name: '三目並べ' } } })
    expect(pkg.entry.sha256).toBe(sha256Hex(JS))
    expect(pkg.icon).toMatchObject({ ext: 'svg', contentType: 'image/svg+xml', sha256: sha256Hex(SVG) })
    expect(pkg.sha256).toBe(sha256Hex(bytes))
  })

  it('drops one top-level folder', () => {
    const pkg = parsePackage(zip({ 'tictac/manifest.json': strToU8(JSON.stringify(manifest())), 'tictac/app.js': JS, 'tictac/icon.svg': SVG }))
    expect(pkg.manifest.id).toBe('tictac')
  })

  it.each([
    ['not a zip', () => parsePackage(strToU8('hello')), 'NOT_A_ZIP'],
    ['an extra file', () => parsePackage(zip({ 'manifest.json': strToU8(JSON.stringify(manifest())), 'app.js': JS, 'icon.svg': SVG, 'index.html': strToU8('<script>') })), 'UNEXPECTED_FILE'],
    ['a nested path', () => parsePackage(zip({ 'manifest.json': strToU8(JSON.stringify(manifest())), 'app.js': JS, 'icon.svg': SVG, 'a/b/c.js': JS })), 'UNEXPECTED_FILE'],
    ['no manifest', () => parsePackage(zip({ 'app.js': JS, 'icon.svg': SVG })), 'MISSING_FILE'],
    ['no entry', () => parsePackage(zip({ 'manifest.json': strToU8(JSON.stringify(manifest())), 'icon.svg': SVG })), 'MISSING_FILE'],
    ['a bad id', () => parsePackage(zip({ 'manifest.json': strToU8(JSON.stringify(manifest({ id: 'Bad!' }))), 'app.js': JS, 'icon.svg': SVG })), 'BAD_MANIFEST'],
    ['an html entry', () => parsePackage(zip({ 'manifest.json': strToU8(JSON.stringify(manifest({ entry: 'app.html' }))), 'app.html': JS, 'icon.svg': SVG })), 'BAD_MANIFEST'],
    ['a fake PNG', () => parsePackage(zip({ 'manifest.json': strToU8(JSON.stringify(manifest({ icon: 'icon.png' }))), 'app.js': JS, 'icon.png': SVG })), 'BAD_ICON'],
    ['an HTML file named SVG', () => parsePackage(zip({ 'manifest.json': strToU8(JSON.stringify(manifest())), 'app.js': JS, 'icon.svg': strToU8('<html><script>alert(1)</script>') })), 'BAD_ICON'],
    ['too many players', () => parsePackage(zip({ 'manifest.json': strToU8(JSON.stringify(manifest({ maxPlayers: 99 }))), 'app.js': JS, 'icon.svg': SVG })), 'BAD_MANIFEST'],
    ['an unknown locale', () => parsePackage(zip({ 'manifest.json': strToU8(JSON.stringify(manifest({ i18n: { xx: { name: 'x' } } }))), 'app.js': JS, 'icon.svg': SVG })), 'BAD_MANIFEST'],
  ])('refuses %s', (_name, fn, expected) => {
    expect(code(fn)).toBe(expected)
  })

  it('refuses an entry over 5 MB before inflating it whole', () => {
    const big = new Uint8Array(6 * 1024 * 1024)
    expect(code(() => parsePackage(zip({ 'manifest.json': strToU8(JSON.stringify(manifest())), 'app.js': big, 'icon.svg': SVG })))).toBe('TOO_LARGE')
  })
})

/* -------------------------------------------------------------------------------------------- */

const db = vi.hoisted(() => ({
  file: null as null | { content_type: string; bytes: string },
  existing: null as null | { version: string | null; enabled: boolean; builtin: boolean },
  rpc: vi.fn(),
}))

vi.mock('../../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: table === 'activity_app_files' ? db.file : db.existing, error: null }),
      }
      return chain
    },
    rpc: db.rpc,
  }),
}))
vi.mock('../../utils/instanceAdmin.js', () => ({
  requireInstanceAdmin: async () => ({ profileId: '11111111-0000-4000-8000-000000000001' }),
}))
vi.mock('../../middleware/rateLimit.js', () => ({
  createStrictKeyedLimit: () => ({ take: async () => true }),
}))
vi.mock('../../utils/ssrfProtection.js', () => ({
  safeFetch: vi.fn(async () => new Response(Buffer.from(good()), { status: 200 })),
}))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { adminActivitiesRouter, packageFilesRouter } = await import('../packageRoutes.js')

function app() {
  const a = express()
  a.use(express.json())
  a.use('/activities', packageFilesRouter)
  a.use('/admin/activities', adminActivitiesRouter)
  return a
}

beforeEach(() => {
  db.file = null
  db.existing = null
  db.rpc.mockReset()
})

describe('package files', () => {
  it('serves a stored file sandboxed, cross-origin readable and immutable', async () => {
    const sha = sha256Hex(SVG)
    db.file = { content_type: 'image/svg+xml', bytes: `\\x${Buffer.from(SVG).toString('hex')}` }
    const res = await supertest(app()).get(`/activities/pkg/tictac/${sha}.svg`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/svg+xml')
    expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'")
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin')
    expect(res.headers['cache-control']).toContain('immutable')
  })

  it.each(['/activities/pkg/tictac/app.js', '/activities/pkg/Tic/0.js', `/activities/pkg/tictac/${'a'.repeat(64)}.html`])('404s %s', async (path) => {
    expect((await supertest(app()).get(path)).status).toBe(404)
  })
})

describe('package admin', () => {
  it('previews an uploaded zip without storing it', async () => {
    const bytes = good()
    const res = await supertest(app()).post('/admin/activities/preview').set('Content-Type', 'application/zip').send(Buffer.from(bytes))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: 'tictac', version: '1.2.3', sha256: sha256Hex(bytes), url: null, existing: null })
    expect(res.body.icon).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('refuses a package that would take a built-in id', async () => {
    db.existing = { version: null, enabled: true, builtin: true }
    const res = await supertest(app()).post('/admin/activities/preview').set('Content-Type', 'application/zip').send(Buffer.from(good()))
    expect(res.body.error).toBe('BUILTIN_ID')
  })

  it('reports a broken package with its code', async () => {
    const res = await supertest(app()).post('/admin/activities/preview').set('Content-Type', 'application/zip').send(Buffer.from('PK nope'))
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('NOT_A_ZIP')
  })

  it('installs from a URL only with the previewed hash', async () => {
    const url = 'https://games.example/tictac.zip'
    let res = await supertest(app()).post('/admin/activities/install').send({ url })
    expect(res.body.error).toBe('NO_EXPECTED_SHA')
    res = await supertest(app()).post('/admin/activities/install').send({ url, expectSha256: 'f'.repeat(64) })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('PACKAGE_CHANGED')

    db.rpc.mockResolvedValue({ data: { id: 'tictac', enabled: false, updated: false }, error: null })
    res = await supertest(app()).post('/admin/activities/install').send({ url, expectSha256: sha256Hex(good()) })
    expect(res.status).toBe(200)
    const [name, args] = db.rpc.mock.calls[0]
    expect(name).toBe('install_activity_package')
    expect(args.p_app).toMatchObject({ id: 'tictac', package_url: url, entry_sha: sha256Hex(JS), icon_ext: 'svg' })
    expect(args.p_files.map((f: { sha256: string }) => f.sha256).sort()).toEqual([sha256Hex(JS), sha256Hex(SVG)].sort())
  })

  it('refuses a plain-HTTP URL', async () => {
    const res = await supertest(app()).post('/admin/activities/preview').send({ url: 'http://games.example/x.zip' })
    expect(res.body.error).toBe('BAD_URL')
  })
})
