import { describe, it, expect, vi, beforeEach } from 'vitest'

// Inbound mention/DM spam heuristics (FederationSpamGuard). Supabase is an
// in-memory double: each table is an array of rows, filters are evaluated on
// read, and upserts land in `upserts`.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', NODE_ENV: 'test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}
let upserts: Array<{ table: string; row: Row; opts: any }> = []

function fakeSupabase() {
  return {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = []
      let limit = Infinity
      const run = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, limit)
      const builder: any = {
        select: () => builder,
        eq: (col: string, val: any) => { filters.push((r) => r[col] === val); return builder },
        in: (col: string, vals: any[]) => { filters.push((r) => vals.includes(r[col])); return builder },
        // follows relationship filter: and(follower_id.in.(..),following_id.eq.X),and(follower_id.eq.X,following_id.in.(..))
        or: (expr: string) => {
          const parts = [...expr.matchAll(/and\(([^)]*\)[^)]*)\)/g)].map((m) => m[1])
          filters.push((r) => parts.some((part) => part.split(/,(?=[a-z_]+\.)/).every((cond) => {
            const [col, op, ...rest] = cond.split('.')
            const val = rest.join('.')
            if (op === 'eq') return r[col] === val
            if (op === 'in') return val.replace(/[()]/g, '').split(',').includes(r[col])
            return false
          })))
          return builder
        },
        limit: (n: number) => { limit = n; return builder },
        maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
        upsert: (row: Row, opts: any) => { upserts.push({ table, row, opts }); return Promise.resolve({ error: null }) },
        then: (resolve: any) => resolve({ data: run(), error: null }),
      }
      return builder
    },
  }
}

vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => fakeSupabase() }))

const {
  evaluateInboundCreate,
  parseSpamConfig,
  countMentions,
  resetSpamConfigCache,
} = await import('../services/FederationSpamGuard.js')

const AUTHOR = 'aaaaaaaa-0000-0000-0000-00000000000a'
const LOCAL = 'bbbbbbbb-0000-0000-0000-00000000000b'
const DAY = 86_400_000

function note(mentions: number) {
  return {
    id: 'https://spam.example/notes/1',
    type: 'Note',
    content: '<p>buy now</p>',
    tag: Array.from({ length: mentions }, (_, i) => ({
      type: 'Mention',
      href: `https://other.example/users/u${i}`,
      name: `@u${i}@other.example`,
    })),
  }
}

function input(object: any) {
  return {
    activity: { id: 'https://spam.example/activities/1', type: 'Create', object },
    object,
    authorId: AUTHOR,
    authorUri: 'https://spam.example/users/bot',
    kind: 'federation_mention' as const,
    targetIds: [LOCAL],
  }
}

function setMode(mode: string, extra: Row = {}) {
  tables.instance_config = [{ config_key: 'antispam', config_value: { federation_spam_mode: mode, ...extra } }]
}

beforeEach(() => {
  resetSpamConfigCache()
  upserts = []
  tables = {
    profiles: [{ id: AUTHOR, created_at: new Date(Date.now() - 1 * DAY).toISOString(), federation_metadata: {} }],
    follows: [],
    conversation_participants: [],
  }
})

describe('parseSpamConfig', () => {
  it('falls back to flag mode with conservative thresholds', () => {
    expect(parseSpamConfig(undefined)).toEqual({
      federation_spam_mode: 'flag',
      federation_max_mentions: 15,
      federation_new_actor_days: 7,
    })
    expect(parseSpamConfig({ federation_spam_mode: 'nuke', federation_max_mentions: 'x' }).federation_spam_mode).toBe('flag')
  })
})

describe('countMentions', () => {
  it('counts distinct Mention tags only', () => {
    const obj = note(3)
    obj.tag.push({ ...obj.tag[0] }, { type: 'Hashtag', name: '#x' } as any)
    expect(countMentions(obj)).toBe(3)
  })
})

describe('evaluateInboundCreate', () => {
  it('allows when the mode is off', async () => {
    setMode('off')
    const v = await evaluateInboundCreate(input(note(40)))
    expect(v.action).toBe('allow')
    expect(upserts).toHaveLength(0)
  })

  it('holds a mass mention and stores the activity for release', async () => {
    setMode('hold', { federation_max_mentions: 10 })
    const v = await evaluateInboundCreate(input(note(12)))
    expect(v.action).toBe('hold')
    expect(v.reasons).toContain('mass_mention')
    expect(upserts[0].table).toBe('suspicious_activity')
    expect(upserts[0].row.action).toBe('held')
    expect(upserts[0].row.activity).toMatchObject({ id: 'https://spam.example/activities/1' })
    expect(upserts[0].opts).toMatchObject({ onConflict: 'activity_id', ignoreDuplicates: true })
  })

  it('flags a new stranger without blocking delivery', async () => {
    setMode('flag')
    const v = await evaluateInboundCreate(input(note(1)))
    expect(v.action).toBe('flag')
    expect(v.reasons).toEqual(expect.arrayContaining(['new_actor', 'no_followers', 'no_relationship', 'unknown_age']))
    expect(upserts[0].row.action).toBe('flagged')
    expect(upserts[0].row.activity).toBeNull()
  })

  it('reads the actor age from ActivityPub published before first-seen', async () => {
    setMode('reject')
    tables.profiles[0].federation_metadata = { ap_published: new Date(Date.now() - 400 * DAY).toISOString() }
    const v = await evaluateInboundCreate(input(note(1)))
    expect(v.action).toBe('allow')
  })

  it('allows a new account that a targeted user follows', async () => {
    setMode('reject')
    tables.follows = [{ id: 'f1', follower_id: LOCAL, following_id: AUTHOR, status: 'accepted' }]
    const v = await evaluateInboundCreate(input(note(1)))
    expect(v.action).toBe('allow')
  })

  it('allows a new account with a local follower', async () => {
    setMode('reject')
    tables.follows = [{ id: 'f2', follower_id: 'cccccccc-0000-0000-0000-00000000000c', following_id: AUTHOR, status: 'accepted' }]
    const v = await evaluateInboundCreate(input(note(1)))
    expect(v.action).toBe('allow')
  })

  it('allows a new account that already shares a conversation with the target', async () => {
    setMode('reject')
    tables.conversation_participants = [
      { conversation_id: 'conv1', user_id: AUTHOR },
      { conversation_id: 'conv1', user_id: LOCAL },
    ]
    const v = await evaluateInboundCreate(input(note(1)))
    expect(v.action).toBe('allow')
  })

  it('does not evaluate a Create addressed to no local user', async () => {
    setMode('reject', { federation_max_mentions: 2 })
    const v = await evaluateInboundCreate({ ...input(note(50)), targetIds: [] })
    expect(v.action).toBe('allow')
  })
})
