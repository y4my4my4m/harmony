import { describe, expect, it, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { deflateRawSync } from 'node:zlib'
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

  it('counts a stored entry by the bytes copied, each record that points at it again', () => {
    // 1 MB stored once, listed 20 times with a declared size of 0: 20 MB of copies unchecked.
    const crafted = sharedStoredEntry(20, 1024 * 1024)
    const before = process.memoryUsage().arrayBuffers
    expect(code(() => parsePackage(crafted))).toBe('TOO_LARGE')
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 * 1024 * 1024)
  })

  it('refuses one stored entry over 5 MB that declares 0 bytes', () => {
    expect(code(() => parsePackage(sharedStoredEntry(1, 5.5 * 1024 * 1024)))).toBe('TOO_LARGE')
  })

  it('stops at 32 zip entries when the end record claims 2^32 - 1', () => {
    const started = performance.now()
    expect(code(() => parsePackage(zip64Claiming(0xffffffff)))).toBe('UNEXPECTED_FILE')
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('stops inflating an entry past its declared size', () => {
    // 64 MB of zeros in 64 KB, declared as 1 byte.
    const bomb = { data: deflateRawSync(Buffer.alloc(64 * 1024 * 1024)), unpacked: 1 }
    const before = process.memoryUsage().arrayBuffers
    expect(code(() => parsePackage(craft([
      { name: 'manifest.json', ...packed(JSON.stringify(manifest())) }, { name: 'app.js', ...bomb }, { name: 'icon.svg', ...packed(SVG) },
    ])))).toBe('NOT_A_ZIP')
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 * 1024 * 1024)
  })

  it('refuses an entry shorter than its declared size', () => {
    expect(code(() => parsePackage(craft([
      { name: 'manifest.json', ...packed(JSON.stringify(manifest())) }, { name: 'app.js', data: deflateRawSync(JS), unpacked: JS.byteLength + 1 }, { name: 'icon.svg', ...packed(SVG) },
    ])))).toBe('NOT_A_ZIP')
  })

  it('refuses two records that point at one local entry', () => {
    expect(code(() => parsePackage(craft([
      { name: 'manifest.json', ...packed(JSON.stringify(manifest())) }, { name: 'app.js', ...packed(SVG) }, { name: 'icon.svg', ...packed(SVG), sameAs: 1 },
    ])))).toBe('NOT_A_ZIP')
  })

  it('refuses an entry inside another one\'s data', () => {
    // The local entry of app.js, stored whole as the data of icon.svg.
    const inner = craft([{ name: 'app.js', ...packed(JS) }])
    const crafted = craft([{ name: 'manifest.json', ...packed(JSON.stringify(manifest())) }, { name: 'icon.svg', data: inner, unpacked: inner.byteLength, method: 0 }, { name: 'app.js', ...packed(JS), within: 1 }])
    expect(code(() => parsePackage(crafted))).toBe('NOT_A_ZIP')
  })

  it('inflates nothing of a zip whose records share one stream', () => {
    // 32 records of one 256 KB stream that inflates to 256 MB.
    const bomb = deflateRawSync(Buffer.alloc(256 * 1024 * 1024))
    const started = performance.now()
    expect(code(() => parsePackage(craft(Array.from({ length: 32 }, (_, i) => ({ name: `f${i}.js`, data: bomb, unpacked: 1, sameAs: 0 })))))).toBe('NOT_A_ZIP')
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('inflates nothing of a file that does not belong', () => {
    const bomb = deflateRawSync(Buffer.alloc(256 * 1024 * 1024))
    const started = performance.now()
    expect(code(() => parsePackage(craft([
      { name: 'manifest.json', ...packed(JSON.stringify(manifest())) }, { name: 'app.js', ...packed(JS) }, { name: 'icon.svg', ...packed(SVG) },
      { name: 'extra.bin', data: bomb, unpacked: 1 },
    ])))).toBe('UNEXPECTED_FILE')
    expect(performance.now() - started).toBeLessThan(200)
  })

  it('refuses a name listed twice', () => {
    expect(code(() => parsePackage(craft([
      { name: 'manifest.json', ...packed(JSON.stringify(manifest())) }, { name: 'app.js', ...packed(JS) }, { name: 'icon.svg', ...packed(SVG) }, { name: 'app.js', ...packed('2') },
    ])))).toBe('UNEXPECTED_FILE')
  })

  it.each([false, true])('reads a zip with a comment (zip64: %s)', (zip64) => {
    const pkg = parsePackage(craft([
      { name: 'manifest.json', ...packed(JSON.stringify(manifest())) }, { name: 'app.js', ...packed(JS) }, { name: 'icon.svg', data: SVG, unpacked: SVG.byteLength, method: 0 },
    ], { zip64, comment: 'built by hand' }))
    expect(pkg.entry.sha256).toBe(sha256Hex(JS))
    expect(pkg.icon.sha256).toBe(sha256Hex(SVG))
  })

  it('refuses a compression method other than stored or deflate', () => {
    const bytes = good()
    // Local header method at 8, central directory record method at 10.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    view.setUint16(8, 99, true)
    const cd = findSignature(bytes, 0x02014b50)
    view.setUint16(cd + 10, 99, true)
    expect(code(() => parsePackage(bytes))).toBe('NOT_A_ZIP')
  })
})

interface Crafted {
  name: string
  data: Uint8Array
  /** Declared unpacked size. */
  unpacked: number
  method?: number
  /** Index of the entry whose local header this record points at. */
  sameAs?: number
  /** Index of the entry whose data this record's local header is taken from. */
  within?: number
}

function packed(content: Uint8Array | string): { data: Uint8Array; unpacked: number } {
  const bytes = typeof content === 'string' ? strToU8(content) : content
  return { data: deflateRawSync(bytes), unpacked: bytes.byteLength }
}

/** A zip of `entries` as listed; with `zip64` the sizes and offsets are in the zip64 records alone. */
function craft(entries: Crafted[], { zip64 = false, comment = '' } = {}): Uint8Array {
  const parts: Buffer[] = []
  const offsets: number[] = []
  const starts: number[] = []
  let length = 0
  const push = (buffer: Buffer) => {
    parts.push(buffer)
    length += buffer.length
  }
  for (const [i, entry] of entries.entries()) {
    const shared = entry.sameAs !== undefined && entry.sameAs !== i
    offsets[i] = shared ? offsets[entry.sameAs!] : entry.within !== undefined ? starts[entry.within] : length
    if (shared || entry.within !== undefined) continue
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(entry.method ?? 8, 8)
    local.writeUInt16LE(entry.name.length, 26)
    push(Buffer.concat([local, Buffer.from(entry.name)]))
    starts[i] = length
    push(Buffer.from(entry.data))
  }
  const directory = length
  for (const [i, entry] of entries.entries()) {
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(entry.method ?? 8, 10)
    record.writeUInt32LE(zip64 ? 0xffffffff : entry.data.byteLength, 20)
    record.writeUInt32LE(zip64 ? 0xffffffff : entry.unpacked, 24)
    record.writeUInt16LE(entry.name.length, 28)
    record.writeUInt16LE(zip64 ? 28 : 0, 30)
    record.writeUInt32LE(zip64 ? 0xffffffff : offsets[i], 42)
    const extra = Buffer.alloc(zip64 ? 28 : 0)
    if (zip64) {
      extra.writeUInt16LE(1, 0)
      extra.writeUInt16LE(24, 2)
      extra.writeBigUInt64LE(BigInt(entry.unpacked), 4)
      extra.writeBigUInt64LE(BigInt(entry.data.byteLength), 12)
      extra.writeBigUInt64LE(BigInt(offsets[i]), 20)
    }
    push(Buffer.concat([record, Buffer.from(entry.name), extra]))
  }
  if (zip64) {
    const end64 = Buffer.alloc(56)
    end64.writeUInt32LE(0x06064b50, 0)
    end64.writeBigUInt64LE(BigInt(entries.length), 32)
    end64.writeBigUInt64LE(BigInt(directory), 48)
    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(0x07064b50, 0)
    locator.writeBigUInt64LE(BigInt(length), 8)
    push(Buffer.concat([end64, locator]))
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8)
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10)
  end.writeUInt32LE(zip64 ? 0xffffffff : directory, 16)
  end.writeUInt16LE(comment.length, 20)
  push(Buffer.concat([end, Buffer.from(comment)]))
  return new Uint8Array(Buffer.concat(parts))
}

/** One stored local entry of `dataLen` bytes, listed by `records` central directory records, each declaring size 0. */
function sharedStoredEntry(records: number, dataLen: number): Uint8Array {
  const name = Buffer.from('x')
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(name.length, 26)
  const head = Buffer.concat([local, name, Buffer.alloc(dataLen, 0x41)])
  const cds: Buffer[] = []
  for (let i = 0; i < records; i++) {
    const nm = Buffer.from(`f${i}.js`)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt32LE(dataLen, 20)
    cd.writeUInt32LE(0, 24)
    cd.writeUInt16LE(nm.length, 28)
    cd.writeUInt32LE(0, 42)
    cds.push(cd, nm)
  }
  const dir = Buffer.concat(cds)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(records, 8)
  end.writeUInt16LE(records, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(head.length, 16)
  return new Uint8Array(Buffer.concat([head, dir, end]))
}

/** A 98-byte zip64 archive whose end record claims `count` entries, its directory past the end. */
function zip64Claiming(count: number): Uint8Array {
  const z64 = Buffer.alloc(56)
  z64.writeUInt32LE(0x06064b50, 0)
  z64.writeUInt32LE(count >>> 0, 32)
  z64.writeUInt32LE(0x7fffff00, 48)
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x07064b50, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0xffff, 8)
  end.writeUInt16LE(0xffff, 10)
  return new Uint8Array(Buffer.concat([z64, locator, end]))
}

function findSignature(bytes: Uint8Array, signature: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i + 4 <= bytes.length; i++) if (view.getUint32(i, true) === signature) return i
  throw new Error('signature not found')
}

/* -------------------------------------------------------------------------------------------- */

const db = vi.hoisted(() => ({
  file: null as null | { content_type: string; bytes: string },
  fileError: null as null | { message: string },
  /** Reads of activity_app_files, and how long one takes, ms. */
  fileReads: 0,
  fileDelay: 0,
  existing: null as null | { version: string | null; enabled: boolean; builtin: boolean },
  rpc: vi.fn(),
}))

vi.mock('../../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          if (table !== 'activity_app_files') return { data: db.existing, error: null }
          db.fileReads++
          if (db.fileDelay) await new Promise((resolve) => setTimeout(resolve, db.fileDelay))
          return db.fileError ? { data: null, error: db.fileError } : { data: db.file, error: null }
        },
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
  db.fileError = null
  db.fileReads = 0
  db.fileDelay = 0
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

  it('reads a file once for concurrent requests and keeps serving it', async () => {
    // 20 reads of 4 MB counted apart are 80 MB, past the 64 MB cache.
    const bytes = Buffer.alloc(4 * 1024 * 1024, 0x41)
    const sha = sha256Hex(bytes)
    db.file = { content_type: 'text/javascript; charset=utf-8', bytes: `\\x${bytes.toString('hex')}` }
    db.fileDelay = 200
    const server = app()
    const path = `/activities/pkg/bulk/${sha}.js`
    const statuses = await Promise.all(Array.from({ length: 20 }, async () => (await supertest(server).get(path)).status))
    expect(statuses).toEqual(Array(20).fill(200))
    expect(db.fileReads).toBe(1)
    expect((await supertest(server).get(path)).status).toBe(200)
    expect(db.fileReads).toBe(1)
  })

  it('keeps at most 64 MB of files, dropping the least recently used', async () => {
    const server = app()
    const paths: string[] = []
    for (let i = 0; i < 18; i++) {
      const bytes = Buffer.alloc(4 * 1024 * 1024, i)
      db.file = { content_type: 'text/javascript; charset=utf-8', bytes: `\\x${bytes.toString('hex')}` }
      paths.push(`/activities/pkg/lru/${sha256Hex(bytes)}.js`)
      expect((await supertest(server).get(paths[i])).status).toBe(200)
    }
    db.fileReads = 0
    expect((await supertest(server).get(paths[17])).status).toBe(200)
    expect(db.fileReads).toBe(0)
    expect((await supertest(server).get(paths[0])).status).toBe(200)
    expect(db.fileReads).toBe(1)
  })

  it('answers 503 while the file cannot be read, and reads again after', async () => {
    const bytes = Buffer.from('later')
    const path = `/activities/pkg/tictac/${sha256Hex(bytes)}.js`
    db.fileError = { message: 'database down' }
    expect((await supertest(app()).get(path)).status).toBe(503)
    db.fileError = null
    db.file = { content_type: 'text/javascript; charset=utf-8', bytes: `\\x${bytes.toString('hex')}` }
    expect((await supertest(app()).get(path)).status).toBe(200)
  })

  it('does not cache a file read while its package is removed', async () => {
    const bytes = Buffer.from('removed')
    const path = `/activities/pkg/going/${sha256Hex(bytes)}.js`
    db.file = { content_type: 'text/javascript; charset=utf-8', bytes: `\\x${bytes.toString('hex')}` }
    db.fileDelay = 100
    const server = app()
    const reading = supertest(server).get(path).then((res) => res.status)
    await vi.waitFor(() => expect(db.fileReads).toBe(1))
    db.rpc.mockResolvedValue({ data: true, error: null })
    expect((await supertest(server).delete('/admin/activities/going')).status).toBe(200)
    expect(await reading).toBe(200)
    db.file = null
    expect((await supertest(server).get(path)).status).toBe(404)
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
