import { describe, it, expect, vi, beforeEach } from 'vitest'

// A server's custom emojis on its copies (copyMirror.ts harmony:emojis,
// CopyMirrorService.applyGroupEmojis): each a server emoji of the copy naming the host's image,
// a row cached from an activity taken over, a dropped one removed but still resolvable.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../services/RedisService.js', () => ({ redis: { getClient: () => null } }))

const GROUP = 'https://remote.test/servers/11111111-1111-4111-8111-111111111111'
const COPY = 'copy-1'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const apId = (n: number) => `${GROUP}/emojis/${id(n)}`
const img = (name: string) => `https://cdn.remote.test/emojis/${name}.webp`

let db: { emojis: any[] }
let failReads = false
let seq = 0
/** Runs before an update applies: a concurrent writer. */
let beforeUpdate: (() => void) | null = null
/** A read selecting these columns answers an error. */
let failSelect: string | null = null

function query(table: string) {
  const filters: Array<(r: any) => boolean> = []
  let op: 'select' | 'update' | 'insert' | 'delete' = 'select'
  let patch: any
  let window: [number, number] | null = null
  let columns = ''
  let head = false
  let sort: { col: string; asc: boolean } | null = null
  const rows = () => {
    const out = ((db as any)[table] || []).filter((r: any) => filters.every(f => f(r)))
    if (sort) {
      const { col, asc } = sort
      out.sort((a: any, b: any) => (String(a[col] ?? '') < String(b[col] ?? '') ? -1 : String(a[col] ?? '') > String(b[col] ?? '') ? 1 : 0) * (asc ? 1 : -1))
    }
    return window ? out.slice(window[0], window[1] + 1) : out
  }
  const settle = () => {
    if (op === 'delete') {
      const hit = new Set(rows())
      ;(db as any)[table] = (db as any)[table].filter((r: any) => !hit.has(r))
      return { data: null, error: null }
    }
    if (head) return failReads ? { count: null, error: { message: 'statement timeout' } } : { count: rows().length, error: null }
    if (op === 'update') {
      beforeUpdate?.()
      beforeUpdate = null
      const hit = rows()
      for (const r of hit) Object.assign(r, patch)
      return { data: hit.map((r: any) => ({ id: r.id })), error: null }
    }
    if (failReads || (failSelect !== null && columns === failSelect)) return { data: null, error: { message: 'statement timeout' } }
    return { data: rows().map((r: any) => ({ ...r })), error: null }
  }
  const q: any = {
    select: (cols?: string, opts?: { head?: boolean }) => { if (cols) columns = cols; head = !!opts?.head; return q },
    gt: (col: string, val: string) => { filters.push(r => String(r[col] ?? '') > val); return q },
    // The one form CopyMirrorService sends: server_id.is.null,server_id.eq.<id>.
    or: (expr: string) => {
      const other = /server_id\.eq\.([^,]+)/.exec(expr)?.[1]
      filters.push(r => (r.server_id ?? null) === null || r.server_id === other)
      return q
    },
    delete: () => { op = 'delete'; return q },
    eq: (col: string, val: unknown) => { filters.push(r => r[col] === val); return q },
    neq: (col: string, val: unknown) => { filters.push(r => r[col] !== val); return q },
    is: (col: string, val: unknown) => { filters.push(r => (r[col] ?? null) === val); return q },
    not: (col: string, operator: string, val: unknown) => {
      if (operator === 'is') filters.push(r => (r[col] ?? null) !== val)
      return q
    },
    in: (col: string, vals: unknown[]) => { filters.push(r => vals.includes(r[col])); return q },
    order: (col: string, opts?: { ascending?: boolean }) => { sort = { col, asc: opts?.ascending !== false }; return q },
    range: (from: number, to: number) => { window = [from, to]; return q },
    update: (p: any) => { op = 'update'; patch = p; return q },
    insert: (r: any) => {
      op = 'insert'
      for (const row of Array.isArray(r) ? r : [r]) {
        (db as any)[table].push({ id: `new-${++seq}`, deleted_at: null, deleted_by: null, created_at: new Date().toISOString(), ...row })
      }
      return Promise.resolve({ error: null })
    },
    then: (resolve: any, reject: any) => Promise.resolve(settle()).then(resolve, reject),
  }
  return q
}

vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => ({ from: query }) }))

const { emojisToAp, parseGroupEmojis, MAX_EMOJIS } = await import('../activitypub/copyMirror.js')
const { CopyMirrorService, urlChunks, COPY_EMOJI_INSERTS_PER_HOUR, COPY_EMOJI_REMOVED_KEPT } = await import('../services/CopyMirrorService.js')

const copyRows = () => db.emojis.filter(e => e.server_id === COPY)
const byAp = (n: number) => db.emojis.find(e => e.ap_id === apId(n))

beforeEach(() => {
  db = { emojis: [] }
  failReads = false
  seq = 0
  beforeUpdate = null
  failSelect = null
})

describe('harmony:emojis on the wire', () => {
  it('lists rows with a shortcode name and an http(s) image', () => {
    expect(emojisToAp('https://h.test/servers/s', [
      { id: 'a', name: 'wave', url: 'https://h.test/e/wave.webp' },
      { id: 'b', name: 'two words', url: 'https://h.test/e/b.webp' },
      { id: 'c', name: 'noimg', url: null },
      { id: 'd', name: 'js', url: 'javascript:alert(1)' },
    ])).toEqual([
      { type: 'Emoji', id: 'https://h.test/servers/s/emojis/a', name: ':wave:', icon: { type: 'Image', url: 'https://h.test/e/wave.webp' } },
    ])
  })

  it('reads none from a Group without the property', () => {
    expect(parseGroupEmojis(undefined, GROUP)).toBeNull()
    expect(parseGroupEmojis({}, GROUP)).toBeNull()
    expect(parseGroupEmojis([], GROUP)).toEqual([])
  })

  it('reads the Group\'s own emojis only, once each, with a shortcode and an http(s) image', () => {
    const emoji = (over: Record<string, unknown>) => ({ type: 'Emoji', id: apId(1), name: ':wave:', icon: { type: 'Image', url: img('wave') }, ...over })
    expect(parseGroupEmojis([
      emoji({}),
      emoji({ name: ':again:' }),
      emoji({ id: apId(2), name: 'bare', icon: [{ type: 'Image', url: img('bare') }] }),
      emoji({ id: `https://elsewhere.test/servers/x/emojis/${id(3)}` }),
      emoji({ id: `${GROUP}/emojis/not-a-uuid` }),
      emoji({ id: apId(4), type: 'Image' }),
      emoji({ id: apId(5), name: ':two words:' }),
      emoji({ id: apId(6), icon: { type: 'Image', url: 'javascript:alert(1)' } }),
      emoji({ id: apId(7), icon: null }),
      null,
      'x',
    ], GROUP)).toEqual([
      { apId: apId(1), name: 'wave', url: img('wave') },
      { apId: apId(2), name: 'bare', url: img('bare') },
    ])
  })

  it(`reads at most ${MAX_EMOJIS}`, () => {
    const many = Array.from({ length: MAX_EMOJIS + 5 }, (_, i) => ({
      type: 'Emoji', id: apId(i + 1), name: `e${i}`, icon: { type: 'Image', url: img(`e${i}`) },
    }))
    expect(parseGroupEmojis(many, GROUP)).toHaveLength(MAX_EMOJIS)
  })
})

describe('applyGroupEmojis', () => {
  it('stores each emoji as a server emoji of the copy naming the host\'s image', async () => {
    await CopyMirrorService.applyGroupEmojis(COPY, GROUP, [
      { apId: apId(1), name: 'wave', url: img('wave') },
      { apId: apId(2), name: 'dance', url: img('dance') },
    ])
    expect(copyRows().map(e => [e.name, e.url, e.scope, e.domain, e.ap_id, e.deleted_at])).toEqual([
      ['wave', img('wave'), 'server', 'remote.test', apId(1), null],
      ['dance', img('dance'), 'server', 'remote.test', apId(2), null],
    ])
  })

  it('takes over the row an activity cached for the same image, keeping its id', async () => {
    db.emojis = [
      { id: 'cached', name: 'wave', url: img('wave'), server_id: null, scope: 'server', domain: 'remote.test', ap_id: null, deleted_at: null },
      { id: 'mine', name: 'wave', url: img('wave'), server_id: null, scope: 'user', domain: 'remote.test', ap_id: null, deleted_at: null },
      { id: 'local', name: 'wave', url: img('wave'), server_id: 'other-server', scope: 'server', domain: null, ap_id: null, deleted_at: null },
    ]
    await CopyMirrorService.applyGroupEmojis(COPY, GROUP, [{ apId: apId(1), name: 'wave', url: img('wave') }])
    expect(copyRows().map(e => e.id)).toEqual(['cached'])
    expect(db.emojis.find(e => e.id === 'cached')).toMatchObject({ server_id: COPY, ap_id: apId(1), scope: 'server' })
    expect(db.emojis.find(e => e.id === 'mine')?.server_id).toBeNull()
    expect(db.emojis.find(e => e.id === 'local')?.server_id).toBe('other-server')
  })

  it('never takes over a row cached from another instance: the Group may list any image', async () => {
    db.emojis = [
      { id: 'theirs', name: 'blob', url: img('blob'), server_id: null, scope: 'server', domain: 'mastodon.test', ap_id: null, deleted_at: null },
    ]
    await CopyMirrorService.applyGroupEmojis(COPY, GROUP, [{ apId: apId(1), name: 'mine', url: img('blob') }])
    expect(db.emojis.find((e) => e.id === 'theirs')).toMatchObject({ server_id: null, ap_id: null, name: 'blob', domain: 'mastodon.test' })
    expect(copyRows().map((e) => [e.ap_id, e.domain])).toEqual([[apId(1), 'remote.test']])
  })

  it('reads the cached rows in requests of a few KB, and changes nothing when that read fails', async () => {
    const long = Array.from({ length: 100 }, (_, i) => `https://db.remote.test/storage/v1/object/public/emojis/${'a'.repeat(100)}/${i}.webp`)
    const parts = urlChunks(long)
    expect(parts.flat()).toEqual(long)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(part.map((u) => encodeURIComponent(u).length + 9).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(4_000)

    failSelect = 'id, url, domain, server_id, ap_id, deleted_at, deleted_by'
    await CopyMirrorService.applyGroupEmojis(COPY, GROUP, [{ apId: apId(1), name: 'wave', url: img('wave') }])
    expect(db.emojis).toEqual([])
  })

  it('renames, changes the image and restores what the Group lists again', async () => {
    db.emojis = [
      { id: 'r1', name: 'old', url: img('old'), server_id: COPY, scope: 'server', domain: 'remote.test', ap_id: apId(1), deleted_at: null },
      { id: 'r2', name: 'back', url: img('back'), server_id: COPY, scope: 'server', domain: 'remote.test', ap_id: apId(2), deleted_at: '2026-01-01T00:00:00Z' },
    ]
    await CopyMirrorService.applyGroupEmojis(COPY, GROUP, [
      { apId: apId(1), name: 'new', url: img('new') },
      { apId: apId(2), name: 'back', url: img('back') },
    ])
    expect(db.emojis.find(e => e.id === 'r1')).toMatchObject({ name: 'new', url: img('new') })
    expect(db.emojis.find(e => e.id === 'r2')?.deleted_at).toBeNull()
    expect(copyRows()).toHaveLength(2)
  })

  it('removes what the Group no longer lists, keeping the row, and leaves the copy\'s own rows', async () => {
    db.emojis = [
      { id: 'r1', name: 'kept', url: img('kept'), server_id: COPY, scope: 'server', domain: 'remote.test', ap_id: apId(1), deleted_at: null },
      { id: 'r2', name: 'dropped', url: img('dropped'), server_id: COPY, scope: 'server', domain: 'remote.test', ap_id: apId(2), deleted_at: null },
      { id: 'own', name: 'own', url: 'emojis/own.webp', server_id: COPY, scope: 'server', domain: null, ap_id: null, deleted_at: null },
    ]
    await CopyMirrorService.applyGroupEmojis(COPY, GROUP, [{ apId: apId(1), name: 'kept', url: img('kept') }])
    expect(byAp(1)?.deleted_at).toBeNull()
    expect(typeof byAp(2)?.deleted_at).toBe('string')
    expect(db.emojis.find(e => e.id === 'own')?.deleted_at).toBeNull()

    await CopyMirrorService.applyGroupEmojis(COPY, GROUP, [])
    expect(typeof byAp(1)?.deleted_at).toBe('string')
    expect(db.emojis).toHaveLength(3)
  })

  it('keeps an emoji an instance admin removed here while the Group lists it, and takes the host\'s renames', async () => {
    db.emojis = [
      { id: 'r1', name: 'old', url: img('old'), server_id: COPY, scope: 'server', domain: 'remote.test', ap_id: apId(1), deleted_at: '2026-01-01T00:00:00Z', deleted_by: 'admin-1' },
    ]
    await CopyMirrorService.applyGroupEmojis(COPY, GROUP, [{ apId: apId(1), name: 'renamed', url: img('renamed') }])
    expect(db.emojis[0]).toMatchObject({ name: 'renamed', url: img('renamed'), deleted_at: '2026-01-01T00:00:00Z', deleted_by: 'admin-1' })
  })

  it('takes over a cached row an instance admin removed and keeps it removed; a removal by a sync is undone', async () => {
    db.emojis = [
      { id: 'banned', name: 'rude', url: img('rude'), server_id: null, scope: 'server', domain: 'remote.test', ap_id: null,
        deleted_at: '2026-01-01T00:00:00Z', deleted_by: 'admin-1' },
      { id: 'synced', name: 'wave', url: img('wave'), server_id: null, scope: 'server', domain: 'remote.test', ap_id: null,
        deleted_at: '2026-01-02T00:00:00Z', deleted_by: null },
    ]
    await CopyMirrorService.applyGroupEmojis(COPY, GROUP, [
      { apId: apId(1), name: 'rude', url: img('rude') },
      { apId: apId(2), name: 'wave', url: img('wave') },
    ])
    expect(db.emojis.find(e => e.id === 'banned')).toMatchObject({
      server_id: COPY, ap_id: apId(1), deleted_at: '2026-01-01T00:00:00Z', deleted_by: 'admin-1',
    })
    expect(db.emojis.find(e => e.id === 'synced')).toMatchObject({ server_id: COPY, ap_id: apId(2), deleted_at: null, deleted_by: null })
    expect(db.emojis).toHaveLength(2)
  })

  it('keeps an admin\'s removal of an image the Group lists again under a new id, or that an old cached row holds', async () => {
    db.emojis = [
      // Removed here by an admin, then listed by the host under another id.
      { id: 'r1', name: 'rude', url: img('rude'), server_id: COPY, scope: 'server', domain: 'remote.test', ap_id: apId(1),
        deleted_at: '2026-01-01T00:00:00Z', deleted_by: 'admin-1' },
      // Cached before 1.9.4 with its image host as domain, removed by an admin.
      { id: 'old', name: 'gross', url: img('gross'), server_id: null, scope: 'server', domain: 'cdn.remote.test', ap_id: null,
        deleted_at: '2026-01-02T00:00:00Z', deleted_by: 'admin-1' },
    ]
    await CopyMirrorService.applyGroupEmojis(COPY, GROUP, [
      { apId: apId(2), name: 'rude', url: img('rude') },
      { apId: apId(3), name: 'gross', url: img('gross') },
    ])
    expect(byAp(2)).toMatchObject({ deleted_at: '2026-01-01T00:00:00Z', deleted_by: 'admin-1' })
    expect(byAp(3)).toMatchObject({ deleted_at: '2026-01-02T00:00:00Z', deleted_by: 'admin-1' })
    expect(db.emojis.find(e => e.id === 'old')?.server_id).toBeNull()
  })

  it(`inserts at most ${COPY_EMOJI_INSERTS_PER_HOUR} emojis per copy an hour`, async () => {
    const recent = new Date().toISOString()
    db.emojis = Array.from({ length: COPY_EMOJI_INSERTS_PER_HOUR - 1 }, (_, i) => ({
      id: `recent-${i}`, name: `r${i}`, url: img(`r${i}`), server_id: COPY, scope: 'server', domain: 'remote.test',
      ap_id: apId(10_000 + i), deleted_at: '2026-01-01T00:00:00Z', deleted_by: null, created_at: recent,
    }))
    await CopyMirrorService.applyGroupEmojis(COPY, GROUP, [
      { apId: apId(1), name: 'one', url: img('one') },
      { apId: apId(2), name: 'two', url: img('two') },
    ])
    expect(byAp(1)).toBeDefined()
    expect(byAp(2)).toBeUndefined()
  })

  it(`keeps the ${COPY_EMOJI_REMOVED_KEPT} emojis the list dropped most recently, and every admin removal`, async () => {
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
    db.emojis = Array.from({ length: COPY_EMOJI_REMOVED_KEPT + 2 }, (_, i) => ({
      id: `gone-${i}`, name: `g${i}`, url: img(`g${i}`), server_id: COPY, scope: 'server', domain: 'remote.test',
      ap_id: apId(20_000 + i), deleted_at: at(i), deleted_by: null, created_at: '2026-01-01T00:00:00Z',
    }))
    db.emojis.push({ id: 'banned', name: 'b', url: img('b'), server_id: COPY, scope: 'server', domain: 'remote.test',
      ap_id: apId(30_000), deleted_at: at(0), deleted_by: 'admin-1', created_at: '2026-01-01T00:00:00Z' })
    await CopyMirrorService.applyGroupEmojis(COPY, GROUP, [])
    const left = copyRows()
    expect(left.filter(e => e.deleted_by === null)).toHaveLength(COPY_EMOJI_REMOVED_KEPT)
    expect(left.find(e => e.id === 'gone-0')).toBeUndefined()
    expect(left.find(e => e.id === 'gone-1')).toBeUndefined()
    expect(left.find(e => e.id === `gone-${COPY_EMOJI_REMOVED_KEPT + 1}`)).toBeDefined()
    expect(left.find(e => e.id === 'banned')).toBeDefined()
  })

  it('stores the emoji when the cached row was taken over meanwhile', async () => {
    db.emojis = [
      { id: 'cached', name: 'wave', url: img('wave'), server_id: null, scope: 'server', domain: 'remote.test', ap_id: null, deleted_at: null },
    ]
    // A concurrent sync of another copy takes the row first.
    beforeUpdate = () => { db.emojis[0].server_id = 'other-copy' }
    await CopyMirrorService.applyGroupEmojis(COPY, GROUP, [{ apId: apId(1), name: 'wave', url: img('wave') }])
    expect(copyRows().map((e) => e.ap_id)).toEqual([apId(1)])
    expect(db.emojis.find((e) => e.id === 'cached')?.server_id).toBe('other-copy')
  })

  it('writes nothing when the copy\'s emojis cannot be read', async () => {
    failReads = true
    await CopyMirrorService.applyGroupEmojis(COPY, GROUP, [{ apId: apId(1), name: 'wave', url: img('wave') }])
    expect(db.emojis).toEqual([])
  })
})
