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

function query(table: string) {
  const filters: Array<(r: any) => boolean> = []
  let op: 'select' | 'update' | 'insert' = 'select'
  let patch: any
  let window: [number, number] | null = null
  const rows = () => {
    const out = ((db as any)[table] || []).filter((r: any) => filters.every(f => f(r)))
    return window ? out.slice(window[0], window[1] + 1) : out
  }
  const settle = () => {
    if (op === 'update') {
      for (const r of rows()) Object.assign(r, patch)
      return { error: null }
    }
    if (failReads) return { data: null, error: { message: 'statement timeout' } }
    return { data: rows().map((r: any) => ({ ...r })), error: null }
  }
  const q: any = {
    select: () => q,
    eq: (col: string, val: unknown) => { filters.push(r => r[col] === val); return q },
    neq: (col: string, val: unknown) => { filters.push(r => r[col] !== val); return q },
    is: (col: string, val: unknown) => { filters.push(r => (r[col] ?? null) === val); return q },
    not: (col: string, operator: string, val: unknown) => {
      if (operator === 'is') filters.push(r => (r[col] ?? null) !== val)
      return q
    },
    in: (col: string, vals: unknown[]) => { filters.push(r => vals.includes(r[col])); return q },
    order: () => q,
    range: (from: number, to: number) => { window = [from, to]; return q },
    update: (p: any) => { op = 'update'; patch = p; return q },
    insert: (r: any) => {
      op = 'insert'
      for (const row of Array.isArray(r) ? r : [r]) (db as any)[table].push({ id: `new-${++seq}`, deleted_at: null, ...row })
      return Promise.resolve({ error: null })
    },
    then: (resolve: any, reject: any) => Promise.resolve(settle()).then(resolve, reject),
  }
  return q
}

vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => ({ from: query }) }))

const { emojisToAp, parseGroupEmojis, MAX_EMOJIS } = await import('../activitypub/copyMirror.js')
const { CopyMirrorService } = await import('../services/CopyMirrorService.js')

const copyRows = () => db.emojis.filter(e => e.server_id === COPY)
const byAp = (n: number) => db.emojis.find(e => e.ap_id === apId(n))

beforeEach(() => {
  db = { emojis: [] }
  failReads = false
  seq = 0
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

  it('writes nothing when the copy\'s emojis cannot be read', async () => {
    failReads = true
    await CopyMirrorService.applyGroupEmojis(COPY, GROUP, [{ apId: apId(1), name: 'wave', url: img('wave') }])
    expect(db.emojis).toEqual([])
  })
})
